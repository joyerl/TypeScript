/// <reference path="builderState.ts" />

/*@internal*/
namespace ts {
    /**
     * State to store the changed files, affected files and cache semantic diagnostics
     */
    export interface BuilderProgramState extends BuilderState {
        /**
         * Cache of semantic diagnostics for files with their Path being the key
         */
        semanticDiagnosticsPerFile: Map<ReadonlyArray<Diagnostic>> | undefined;
        /**
         * The map has key by source file's path that has been changed
         */
        changedFilesSet: Map<true>;
        /**
         * Set of affected files being iterated
         */
        affectedFiles: ReadonlyArray<SourceFile> | undefined;
        /**
         * Current index to retrieve affected file from
         */
        affectedFilesIndex: number | undefined;
        /**
         * Current changed file for iterating over affected files
         */
        currentChangedFilePath: Path | undefined;
        /**
         * Map of file signatures, with key being file path, calculated while getting current changed file's affected files
         * These will be commited whenever the iteration through affected files of current changed file is complete
         */
        currentAffectedFilesSignatures: Map<string> | undefined;
        /**
         * Already seen affected files
         */
        seenAffectedFiles: Map<true> | undefined;
        /**
         * program corresponding to this state
         */
        program: Program;
    }

    function hasSameKeys<T, U>(map1: ReadonlyMap<T> | undefined, map2: ReadonlyMap<U> | undefined) {
        if (map1 === undefined) {
            return map2 === undefined;
        }
        if (map2 === undefined) {
            return map1 === undefined;
        }
        // Has same size and every key is present in both maps
        return map1.size === map2.size && !forEachKey(map1, key => !map2.has(key));
    }

    /**
     * Create the state so that we can iterate on changedFiles/affected files
     */
    function createBuilderProgramState(newProgram: Program, getCanonicalFileName: GetCanonicalFileName, oldState?: Readonly<BuilderProgramState>): BuilderProgramState {
        const state = BuilderState.create(newProgram, getCanonicalFileName, oldState) as BuilderProgramState;
        state.program = newProgram;
        const compilerOptions = newProgram.getCompilerOptions();
        if (!compilerOptions.outFile && !compilerOptions.out) {
            state.semanticDiagnosticsPerFile = createMap<ReadonlyArray<Diagnostic>>();
        }
        state.changedFilesSet = createMap<true>();
        const useOldState = BuilderState.canReuseOldState(state.referencedMap, oldState);
        const canCopySemanticDiagnostics = useOldState && oldState.semanticDiagnosticsPerFile && !!state.semanticDiagnosticsPerFile;
        if (useOldState) {
            // Verify the sanity of old state
            if (!oldState.currentChangedFilePath) {
                Debug.assert(!oldState.affectedFiles && (!oldState.currentAffectedFilesSignatures || !oldState.currentAffectedFilesSignatures.size), "Cannot reuse if only few affected files of currentChangedFile were iterated");
            }
            if (canCopySemanticDiagnostics) {
                Debug.assert(!forEachKey(oldState.changedFilesSet, path => oldState.semanticDiagnosticsPerFile.has(path)), "Semantic diagnostics shouldnt be available for changed files");
            }

            // Copy old state's changed files set
            copyEntries(oldState.changedFilesSet, state.changedFilesSet);
        }

        // Update changed files and copy semantic diagnostics if we can
        const referencedMap = state.referencedMap;
        const oldReferencedMap = useOldState && oldState.referencedMap;
        state.fileInfos.forEach((info, sourceFilePath) => {
            let oldInfo: Readonly<BuilderState.FileInfo>;
            let newReferences: BuilderState.ReferencedSet;

            // if not using old state, every file is changed
            if (!useOldState ||
                // File wasnt present in old state
                !(oldInfo = oldState.fileInfos.get(sourceFilePath)) ||
                // versions dont match
                oldInfo.version !== info.version ||
                // Referenced files changed
                !hasSameKeys(newReferences = referencedMap && referencedMap.get(sourceFilePath), oldReferencedMap && oldReferencedMap.get(sourceFilePath)) ||
                // Referenced file was deleted in the new program
                newReferences && forEachKey(newReferences, path => !state.fileInfos.has(path) && oldState.fileInfos.has(path))) {
                // Register file as changed file and do not copy semantic diagnostics, since all changed files need to be re-evaluated
                state.changedFilesSet.set(sourceFilePath, true);
            }
            else if (canCopySemanticDiagnostics) {
                // Unchanged file copy diagnostics
                const diagnostics = oldState.semanticDiagnosticsPerFile.get(sourceFilePath);
                if (diagnostics) {
                    state.semanticDiagnosticsPerFile.set(sourceFilePath, diagnostics);
                }
            }
        });

        return state;
    }

    /**
     * Verifies that source file is ok to be used in calls that arent handled by next
     */
    function assertSourceFileOkWithoutNextAffectedCall(state: BuilderProgramState, sourceFile: SourceFile | undefined) {
        Debug.assert(!sourceFile || !state.affectedFiles || state.affectedFiles[state.affectedFilesIndex - 1] !== sourceFile || !state.semanticDiagnosticsPerFile.has(sourceFile.path));
    }

    /**
     * This function returns the next affected file to be processed.
     * Note that until doneAffected is called it would keep reporting same result
     * This is to allow the callers to be able to actually remove affected file only when the operation is complete
     * eg. if during diagnostics check cancellation token ends up cancelling the request, the affected file should be retained
     */
    function getNextAffectedFile(state: BuilderProgramState, cancellationToken: CancellationToken | undefined, computeHash: BuilderState.ComputeHash): SourceFile | Program | undefined {
        while (true) {
            const { affectedFiles } = state;
            if (affectedFiles) {
                const { seenAffectedFiles, semanticDiagnosticsPerFile } = state;
                let { affectedFilesIndex } = state;
                while (affectedFilesIndex < affectedFiles.length) {
                    const affectedFile = affectedFiles[affectedFilesIndex];
                    if (!seenAffectedFiles.has(affectedFile.path)) {
                        // Set the next affected file as seen and remove the cached semantic diagnostics
                        state.affectedFilesIndex = affectedFilesIndex;
                        semanticDiagnosticsPerFile.delete(affectedFile.path);
                        return affectedFile;
                    }
                    seenAffectedFiles.set(affectedFile.path, true);
                    affectedFilesIndex++;
                }

                // Remove the changed file from the change set
                state.changedFilesSet.delete(state.currentChangedFilePath);
                state.currentChangedFilePath = undefined;
                // Commit the changes in file signature
                BuilderState.updateSignaturesFromCache(state, state.currentAffectedFilesSignatures);
                state.currentAffectedFilesSignatures.clear();
                state.affectedFiles = undefined;
            }

            // Get next changed file
            const nextKey = state.changedFilesSet.keys().next();
            if (nextKey.done) {
                // Done
                return undefined;
            }

            // With --out or --outFile all outputs go into single file
            // so operations are performed directly on program, return program
            const compilerOptions = state.program.getCompilerOptions();
            if (compilerOptions.outFile || compilerOptions.out) {
                Debug.assert(!state.semanticDiagnosticsPerFile);
                return state.program;
            }

            // Get next batch of affected files
            state.currentAffectedFilesSignatures = state.currentAffectedFilesSignatures || createMap();
            state.affectedFiles = BuilderState.getFilesAffectedBy(state, state.program, nextKey.value as Path, cancellationToken, computeHash, state.currentAffectedFilesSignatures);
            state.currentChangedFilePath = nextKey.value as Path;
            state.semanticDiagnosticsPerFile.delete(nextKey.value as Path);
            state.affectedFilesIndex = 0;
            state.seenAffectedFiles = state.seenAffectedFiles || createMap<true>();
        }
    }

    /**
     * This is called after completing operation on the next affected file.
     * The operations here are postponed to ensure that cancellation during the iteration is handled correctly
     */
    function doneWithAffectedFile(state: BuilderProgramState, affected: SourceFile | Program) {
        if (affected === state.program) {
            state.changedFilesSet.clear();
        }
        else {
            state.seenAffectedFiles.set((affected as SourceFile).path, true);
            state.affectedFilesIndex++;
        }
    }

    /**
     * Returns the result with affected file
     */
    function toAffectedFileResult<T>(state: BuilderProgramState, result: T, affected: SourceFile | Program): AffectedFileResult<T> {
        doneWithAffectedFile(state, affected);
        return { result, affected };
    }

    /**
     * Gets the semantic diagnostics either from cache if present, or otherwise from program and caches it
     * Note that it is assumed that the when asked about semantic diagnostics, the file has been taken out of affected files/changed file set
     */
    function getSemanticDiagnosticsOfFile(state: BuilderProgramState, sourceFile: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic> {
        const path = sourceFile.path;
        const cachedDiagnostics = state.semanticDiagnosticsPerFile.get(path);
        // Report the semantic diagnostics from the cache if we already have those diagnostics present
        if (cachedDiagnostics) {
            return cachedDiagnostics;
        }

        // Diagnostics werent cached, get them from program, and cache the result
        const diagnostics = state.program.getSemanticDiagnostics(sourceFile, cancellationToken);
        state.semanticDiagnosticsPerFile.set(path, diagnostics);
        return diagnostics;
    }

    export enum BuilderProgramKind {
        SemanticDiagnosticsBuilderProgram,
        EmitAndSemanticDiagnosticsBuilderProgram
    }

    export function createBuilderProgram(newProgram: Program, host: BuilderProgramHost, oldProgram: BaseBuilderProgram | undefined, kind: BuilderProgramKind.SemanticDiagnosticsBuilderProgram): SemanticDiagnosticsBuilderProgram;
    export function createBuilderProgram(newProgram: Program, host: BuilderProgramHost, oldProgram: BaseBuilderProgram | undefined, kind: BuilderProgramKind.EmitAndSemanticDiagnosticsBuilderProgram): EmitAndSemanticDiagnosticsBuilderProgram;
    export function createBuilderProgram(newProgram: Program, host: BuilderProgramHost, oldProgram: BaseBuilderProgram | undefined, kind: BuilderProgramKind) {
        // Return same program if underlying program doesnt change
        let oldState = oldProgram && oldProgram.getState();
        if (oldState && newProgram === oldState.program) {
            newProgram = undefined;
            oldState = undefined;
            return oldProgram;
        }

        /**
         * Create the canonical file name for identity
         */
        const getCanonicalFileName = createGetCanonicalFileName(host.useCaseSensitiveFileNames());
        /**
         * Computing hash to for signature verification
         */
        const computeHash = host.createHash || identity;
        const state = createBuilderProgramState(newProgram, getCanonicalFileName, oldState);

        // To ensure that we arent storing any references to old program or new program without state
        newProgram = undefined;
        oldProgram = undefined;
        oldState = undefined;

        const result: BaseBuilderProgram = {
            getState: () => state,
            getCompilerOptions: () => state.program.getCompilerOptions(),
            getSourceFile: fileName => state.program.getSourceFile(fileName),
            getSourceFiles: () => state.program.getSourceFiles(),
            getOptionsDiagnostics: cancellationToken => state.program.getOptionsDiagnostics(cancellationToken),
            getGlobalDiagnostics: cancellationToken => state.program.getGlobalDiagnostics(cancellationToken),
            getSyntacticDiagnostics: (sourceFile, cancellationToken) => state.program.getSyntacticDiagnostics(sourceFile, cancellationToken),
            getSemanticDiagnostics,
            emit,
            getAllDependencies: sourceFile => BuilderState.getAllDependencies(state, state.program, sourceFile)
        };

        if (kind === BuilderProgramKind.SemanticDiagnosticsBuilderProgram) {
            (result as SemanticDiagnosticsBuilderProgram).getSemanticDiagnosticsOfNextAffectedFile = getSemanticDiagnosticsOfNextAffectedFile;
        }
        else if (kind === BuilderProgramKind.EmitAndSemanticDiagnosticsBuilderProgram) {
            (result as EmitAndSemanticDiagnosticsBuilderProgram).getCurrentDirectory = () => state.program.getCurrentDirectory();
            (result as EmitAndSemanticDiagnosticsBuilderProgram).emitNextAffectedFile = emitNextAffectedFile;
        }
        else {
            notImplemented();
        }

        return result;

        /**
         * Emits the next affected file's emit result (EmitResult and sourceFiles emitted) or returns undefined if iteration is complete
         * The first of writeFile if provided, writeFile of BuilderProgramHost if provided, writeFile of compiler host
         * in that order would be used to write the files
         */
        function emitNextAffectedFile(writeFile?: WriteFileCallback, cancellationToken?: CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: CustomTransformers): AffectedFileResult<EmitResult> {
            const affected = getNextAffectedFile(state, cancellationToken, computeHash);
            if (!affected) {
                // Done
                return undefined;
            }

            return toAffectedFileResult(
                state,
                // When whole program is affected, do emit only once (eg when --out or --outFile is specified)
                // Otherwise just affected file
                state.program.emit(affected === state.program ? undefined : affected as SourceFile, writeFile || host.writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers),
                affected
            );
        }

        /**
         * Emits the JavaScript and declaration files.
         * When targetSource file is specified, emits the files corresponding to that source file,
         * otherwise for the whole program.
         * In case of EmitAndSemanticDiagnosticsBuilderProgram, when targetSourceFile is specified,
         * it is assumed that that file is handled from affected file list. If targetSourceFile is not specified,
         * it will only emit all the affected files instead of whole program
         *
         * The first of writeFile if provided, writeFile of BuilderProgramHost if provided, writeFile of compiler host
         * in that order would be used to write the files
         */
        function emit(targetSourceFile?: SourceFile, writeFile?: WriteFileCallback, cancellationToken?: CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: CustomTransformers): EmitResult {
            if (kind === BuilderProgramKind.EmitAndSemanticDiagnosticsBuilderProgram) {
                assertSourceFileOkWithoutNextAffectedCall(state, targetSourceFile);
                if (!targetSourceFile) {
                    // Emit and report any errors we ran into.
                    let sourceMaps: SourceMapData[] = [];
                    let emitSkipped: boolean;
                    let diagnostics: Diagnostic[];
                    let emittedFiles: string[] = [];

                    let affectedEmitResult: AffectedFileResult<EmitResult>;
                    while (affectedEmitResult = emitNextAffectedFile(writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers)) {
                        emitSkipped = emitSkipped || affectedEmitResult.result.emitSkipped;
                        diagnostics = addRange(diagnostics, affectedEmitResult.result.diagnostics);
                        emittedFiles = addRange(emittedFiles, affectedEmitResult.result.emittedFiles);
                        sourceMaps = addRange(sourceMaps, affectedEmitResult.result.sourceMaps);
                    }
                    return {
                        emitSkipped,
                        diagnostics: diagnostics || emptyArray,
                        emittedFiles,
                        sourceMaps
                    };
                }
            }
            return state.program.emit(targetSourceFile, writeFile || host.writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers);
        }

        /**
         * Return the semantic diagnostics for the next affected file or undefined if iteration is complete
         * If provided ignoreSourceFile would be called before getting the diagnostics and would ignore the sourceFile if the returned value was true
         */
        function getSemanticDiagnosticsOfNextAffectedFile(cancellationToken?: CancellationToken, ignoreSourceFile?: (sourceFile: SourceFile) => boolean): AffectedFileResult<ReadonlyArray<Diagnostic>> {
            while (true) {
                const affected = getNextAffectedFile(state, cancellationToken, computeHash);
                if (!affected) {
                    // Done
                    return undefined;
                }
                else if (affected === state.program) {
                    // When whole program is affected, get all semantic diagnostics (eg when --out or --outFile is specified)
                    return toAffectedFileResult(
                        state,
                        state.program.getSemanticDiagnostics(/*targetSourceFile*/ undefined, cancellationToken),
                        affected
                    );
                }

                // Get diagnostics for the affected file if its not ignored
                if (ignoreSourceFile && ignoreSourceFile(affected as SourceFile)) {
                    // Get next affected file
                    doneWithAffectedFile(state, affected);
                    continue;
                }

                return toAffectedFileResult(
                    state,
                    getSemanticDiagnosticsOfFile(state, affected as SourceFile, cancellationToken),
                    affected
                );
            }
        }

        /**
         * Gets the semantic diagnostics from the program corresponding to this state of file (if provided) or whole program
         * The semantic diagnostics are cached and managed here
         * Note that it is assumed that when asked about semantic diagnostics through this API,
         * the file has been taken out of affected files so it is safe to use cache or get from program and cache the diagnostics
         * In case of SemanticDiagnosticsBuilderProgram if the source file is not provided,
         * it will iterate through all the affected files, to ensure that cache stays valid and yet provide a way to get all semantic diagnostics
         */
        function getSemanticDiagnostics(sourceFile?: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic> {
            assertSourceFileOkWithoutNextAffectedCall(state, sourceFile);
            const compilerOptions = state.program.getCompilerOptions();
            if (compilerOptions.outFile || compilerOptions.out) {
                Debug.assert(!state.semanticDiagnosticsPerFile);
                // We dont need to cache the diagnostics just return them from program
                return state.program.getSemanticDiagnostics(sourceFile, cancellationToken);
            }

            if (sourceFile) {
                return getSemanticDiagnosticsOfFile(state, sourceFile, cancellationToken);
            }

            if (kind === BuilderProgramKind.SemanticDiagnosticsBuilderProgram) {
                // When semantic builder asks for diagnostics of the whole program,
                // ensure that all the affected files are handled
                let affected: SourceFile | Program | undefined;
                while (affected = getNextAffectedFile(state, cancellationToken, computeHash)) {
                    doneWithAffectedFile(state, affected);
                }
            }

            let diagnostics: Diagnostic[];
            for (const sourceFile of state.program.getSourceFiles()) {
                diagnostics = addRange(diagnostics, getSemanticDiagnosticsOfFile(state, sourceFile, cancellationToken));
            }
            return diagnostics || emptyArray;
        }
    }
}

namespace ts {
    export type AffectedFileResult<T> = { result: T; affected: SourceFile | Program; } | undefined;

    export interface BuilderProgramHost {
        /**
         * return true if file names are treated with case sensitivity
         */
        useCaseSensitiveFileNames(): boolean;
        /**
         * If provided this would be used this hash instead of actual file shape text for detecting changes
         */
        createHash?: (data: string) => string;
        /**
         * When emit or emitNextAffectedFile are called without writeFile,
         * this callback if present would be used to write files
         */
        writeFile?: WriteFileCallback;
    }

    /**
     * Builder to manage the program state changes
     */
    export interface BaseBuilderProgram {
        /*@internal*/
        getState(): BuilderProgramState;
        /**
         * Get compiler options of the program
         */
        getCompilerOptions(): CompilerOptions;
        /**
         * Get the source file in the program with file name
         */
        getSourceFile(fileName: string): SourceFile | undefined;
        /**
         * Get a list of files in the program
         */
        getSourceFiles(): ReadonlyArray<SourceFile>;
        /**
         * Get the diagnostics for compiler options
         */
        getOptionsDiagnostics(cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic>;
        /**
         * Get the diagnostics that dont belong to any file
         */
        getGlobalDiagnostics(cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic>;
        /**
         * Get the syntax diagnostics, for all source files if source file is not supplied
         */
        getSyntacticDiagnostics(sourceFile?: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic>;
        /**
         * Get all the dependencies of the file
         */
        getAllDependencies(sourceFile: SourceFile): ReadonlyArray<string>;
        /**
         * Gets the semantic diagnostics from the program corresponding to this state of file (if provided) or whole program
         * The semantic diagnostics are cached and managed here
         * Note that it is assumed that when asked about semantic diagnostics through this API,
         * the file has been taken out of affected files so it is safe to use cache or get from program and cache the diagnostics
         * In case of SemanticDiagnosticsBuilderProgram if the source file is not provided,
         * it will iterate through all the affected files, to ensure that cache stays valid and yet provide a way to get all semantic diagnostics
         */
        getSemanticDiagnostics(sourceFile?: SourceFile, cancellationToken?: CancellationToken): ReadonlyArray<Diagnostic>;
        /**
         * Emits the JavaScript and declaration files.
         * When targetSource file is specified, emits the files corresponding to that source file,
         * otherwise for the whole program.
         * In case of EmitAndSemanticDiagnosticsBuilderProgram, when targetSourceFile is specified,
         * it is assumed that that file is handled from affected file list. If targetSourceFile is not specified,
         * it will only emit all the affected files instead of whole program
         *
         * The first of writeFile if provided, writeFile of BuilderProgramHost if provided, writeFile of compiler host
         * in that order would be used to write the files
         */
        emit(targetSourceFile?: SourceFile, writeFile?: WriteFileCallback, cancellationToken?: CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: CustomTransformers): EmitResult;
    }

    /**
     * The builder that caches the semantic diagnostics for the program and handles the changed files and affected files
     */
    export interface SemanticDiagnosticsBuilderProgram extends BaseBuilderProgram {
        /**
         * Gets the semantic diagnostics from the program for the next affected file and caches it
         * Returns undefined if the iteration is complete
         */
        getSemanticDiagnosticsOfNextAffectedFile(cancellationToken?: CancellationToken, ignoreSourceFile?: (sourceFile: SourceFile) => boolean): AffectedFileResult<ReadonlyArray<Diagnostic>>;
    }

    /**
     * The builder that can handle the changes in program and iterate through changed file to emit the files
     * The semantic diagnostics are cached per file and managed by clearing for the changed/affected files
     */
    export interface EmitAndSemanticDiagnosticsBuilderProgram extends BaseBuilderProgram {
        /**
         * Get the current directory of the program
         */
        getCurrentDirectory(): string;
        /**
         * Emits the next affected file's emit result (EmitResult and sourceFiles emitted) or returns undefined if iteration is complete
         * The first of writeFile if provided, writeFile of BuilderProgramHost if provided, writeFile of compiler host
         * in that order would be used to write the files
         */
        emitNextAffectedFile(writeFile?: WriteFileCallback, cancellationToken?: CancellationToken, emitOnlyDtsFiles?: boolean, customTransformers?: CustomTransformers): AffectedFileResult<EmitResult>;
    }

    /**
     * Create the builder to manage semantic diagnostics and cache them
     */
    export function createSemanticDiagnosticsBuilderProgram(newProgram: Program, host: BuilderProgramHost, oldProgram?: SemanticDiagnosticsBuilderProgram): SemanticDiagnosticsBuilderProgram {
        return createBuilderProgram(newProgram, host, oldProgram, BuilderProgramKind.SemanticDiagnosticsBuilderProgram);
    }

    /**
     * Create the builder that can handle the changes in program and iterate through changed files
     * to emit the those files and manage semantic diagnostics cache as well
     */
    export function createEmitAndSemanticDiagnosticsBuilderProgram(newProgram: Program, host: BuilderProgramHost, oldProgram?: EmitAndSemanticDiagnosticsBuilderProgram): EmitAndSemanticDiagnosticsBuilderProgram {
        return createBuilderProgram(newProgram, host, oldProgram, BuilderProgramKind.EmitAndSemanticDiagnosticsBuilderProgram);
    }
}
