import { commentStorageBasename } from "./comment-storage";

/** Minimal adapter subset supported by Obsidian on desktop and mobile. */
export interface CommentStorageAdapter {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
}

export class CommentStorageCommitError extends Error {
    constructor(
        message: string,
        public readonly committed: boolean,
        public readonly originalError: unknown,
        public readonly recoveryError?: unknown,
    ) {
        super(message);
        this.name = "CommentStorageCommitError";
    }
}

interface Operation { name: string; hadOriginal: boolean; hasContent: boolean; originalHash: string | null }
interface Journal { version: 1; id: string; folder: string; operations: Operation[] }
const PENDING = ".taube-comments-pending.json";
const COMMITTED = ".taube-comments-committed.json";

function hasControlCharacters(value: string): boolean {
    return Array.from(value).some(character => character.charCodeAt(0) < 32);
}

function validFolder(folder: string): void {
    if (!folder || hasControlCharacters(folder) || /[\\:]/.test(folder) || folder.split("/").some(part => !part || part === "." || part === "..")) {
        throw new Error("Invalid comment storage folder");
    }
}

function validName(name: string): boolean {
    return name.length > 5 && name.endsWith(".json") && !hasControlCharacters(name) && !/[<>:"/\\|?*]/.test(name)
        && !name.toLowerCase().startsWith(".taube-comments-") && !/[. ]$/.test(name);
}

function parseJournal(content: string, folder: string): Journal {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid comment transaction journal");
    const value = parsed as Record<string, unknown>;
    if (value.version !== 1 || value.folder !== folder || typeof value.id !== "string" || !/^[a-f0-9]{32}$/.test(value.id)
        || !Array.isArray(value.operations) || value.operations.length === 0) throw new Error("Invalid comment transaction journal");
    const names = new Set<string>();
    const operations: Operation[] = value.operations.map((entry: unknown) => {
        if (!entry || typeof entry !== "object") throw new Error("Invalid comment transaction operation");
        const op = entry as Record<string, unknown>;
        if (typeof op.name !== "string" || !validName(op.name) || typeof op.hadOriginal !== "boolean" || typeof op.hasContent !== "boolean"
            || names.has(op.name.toLowerCase())
            || (op.hadOriginal ? typeof op.originalHash !== "string" || !/^note-v2-[a-f0-9]{64}$/.test(op.originalHash) : op.originalHash !== null)) throw new Error("Invalid comment transaction operation");
        names.add(op.name.toLowerCase());
        return { name: op.name, hadOriginal: op.hadOriginal, hasContent: op.hasContent, originalHash: op.originalHash as string | null };
    });
    return { version: 1, id: value.id, folder, operations };
}

function target(journal: Journal, name: string): string { return `${journal.folder}/${name}`; }
function artifact(journal: Journal, suffix: string): string { return target(journal, `.taube-comments-${journal.id}-${suffix}`); }

async function removeIfPresent(adapter: CommentStorageAdapter, path: string): Promise<void> {
    if (await adapter.exists(path)) await adapter.remove(path);
}

async function rollback(adapter: CommentStorageAdapter, journal: Journal): Promise<void> {
    for (let i = journal.operations.length - 1; i >= 0; i--) {
        const op = journal.operations[i];
        const destination = target(journal, op.name);
        const backup = artifact(journal, `${i}.backup`);
        if (op.hadOriginal) {
            if (await adapter.exists(backup)) {
                if (commentStorageBasename(await adapter.read(backup)) !== op.originalHash) throw new Error("Original comment backup is damaged");
                await removeIfPresent(adapter, destination);
                await adapter.rename(backup, destination);
            } else if (!(await adapter.exists(destination)) || commentStorageBasename(await adapter.read(destination)) !== op.originalHash) {
                // Missing backup is safe only before its move or after a prior restore.
                throw new Error("Original comment backup is missing; keep journal for repair");
            }
        } else {
            await removeIfPresent(adapter, destination);
        }
        await removeIfPresent(adapter, artifact(journal, `${i}.stage`));
    }
    await removeIfPresent(adapter, artifact(journal, "journal"));
    await removeIfPresent(adapter, artifact(journal, "commit"));
    // Keep the pending journal until every restore and cleanup has succeeded.
    await removeIfPresent(adapter, target(journal, PENDING));
}

async function cleanCommitted(adapter: CommentStorageAdapter, journal: Journal): Promise<void> {
    for (let i = 0; i < journal.operations.length; i++) {
        await removeIfPresent(adapter, artifact(journal, `${i}.backup`));
        await removeIfPresent(adapter, artifact(journal, `${i}.stage`));
    }
    await removeIfPresent(adapter, artifact(journal, "journal"));
    await removeIfPresent(adapter, artifact(journal, "commit"));
    await removeIfPresent(adapter, target(journal, PENDING));
    // The committed journal is last: interrupted cleanup can always be retried.
    await removeIfPresent(adapter, target(journal, COMMITTED));
}

/**
 * Call before listing/loading comment JSON. A pending transaction rolls back;
 * an immutable committed journal means new data wins and only backups are
 * cleaned. Invalid/unreadable journals cause an error without touching data.
 * The caller must serialize all saves/recovery for this folder (one writer).
 */
export async function recoverCommentFiles(adapter: CommentStorageAdapter, dataFolder: string): Promise<void> {
    validFolder(dataFolder);
    let pending: Journal | undefined;
    let committed: Journal | undefined;
    if (await adapter.exists(`${dataFolder}/${PENDING}`)) pending = parseJournal(await adapter.read(`${dataFolder}/${PENDING}`), dataFolder);
    if (await adapter.exists(`${dataFolder}/${COMMITTED}`)) committed = parseJournal(await adapter.read(`${dataFolder}/${COMMITTED}`), dataFolder);
    if (pending && committed && JSON.stringify(pending) !== JSON.stringify(committed)) throw new Error("Conflicting comment transaction journals");
    if (committed) {
        try { await cleanCommitted(adapter, committed); }
        catch (error) { throw new CommentStorageCommitError("Comments saved; backup cleanup must be retried", true, error); }
    } else if (pending) {
        try { await rollback(adapter, pending); }
        catch (error) { throw new CommentStorageCommitError("Comment transaction recovery must be retried", false, error); }
    }
}

function transactionId(): string {
    const bytes = new Uint8Array(16);
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") throw new Error("Secure random IDs are unavailable");
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Commit direct child JSON paths; null deletes a previously loaded file.
 * Stages all contents before moving any original. Originals move to backups;
 * the immutable committed journal is published only after all installs succeed.
 * Pending failures restore originals. Post-commit cleanup failures throw an
 * error with committed=true: retain new in-memory state and retry recovery.
 *
 * Adapter rename must be atomic within a folder; successful adapter operations
 * are treated as durable. The adapter does not expose fsync, so this protects
 * process interruption, not hardware/filesystem violations of those guarantees.
 */
export async function commitCommentFiles(
    adapter: CommentStorageAdapter,
    changes: Map<string, string | null>,
    dataFolder: string,
): Promise<void> {
    validFolder(dataFolder);
    const prefix = `${dataFolder}/`;
    const names = new Set<string>();
    for (const [path, content] of changes) {
        const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
        if (!validName(name) || names.has(name.toLowerCase()) || (content !== null && typeof content !== "string")) {
            throw new CommentStorageCommitError("Invalid comment storage change", false, new Error(path));
        }
        names.add(name.toLowerCase());
    }
    try { await recoverCommentFiles(adapter, dataFolder); }
    catch (error) { throw new CommentStorageCommitError("Previous comment transaction must recover before saving", false, error, error); }
    if (changes.size === 0) return;
    const journal: Journal = { version: 1, id: transactionId(), folder: dataFolder, operations: [] };
    for (const [path, content] of changes) {
        const hadOriginal = await adapter.exists(path);
        const originalHash = hadOriginal ? commentStorageBasename(await adapter.read(path)) : null;
        journal.operations.push({ name: path.slice(prefix.length), hadOriginal, hasContent: content !== null, originalHash });
    }
    const pendingPath = target(journal, PENDING);
    const committedPath = target(journal, COMMITTED);
    let published = false;
    let committed = false;
    // Check before entering cleanup scope: colliding artifacts are not ours.
    const artifacts = [artifact(journal, "journal"), artifact(journal, "commit")];
    for (let i = 0; i < journal.operations.length; i++) artifacts.push(artifact(journal, `${i}.stage`), artifact(journal, `${i}.backup`));
    for (const path of artifacts) {
        if (await adapter.exists(path)) throw new CommentStorageCommitError("Comment transaction ID collision", false, new Error(path));
    }
    try {
        const serialized = JSON.stringify(journal);
        await adapter.write(artifact(journal, "journal"), serialized);
        await adapter.rename(artifact(journal, "journal"), pendingPath);
        published = true;
        let index = 0;
        for (const content of changes.values()) {
            if (content !== null) await adapter.write(artifact(journal, `${index}.stage`), content);
            index++;
        }
        for (let i = 0; i < journal.operations.length; i++) {
            const op = journal.operations[i];
            const path = target(journal, op.name);
            if (op.hadOriginal) await adapter.rename(path, artifact(journal, `${i}.backup`));
            if (op.hasContent) await adapter.rename(artifact(journal, `${i}.stage`), path);
        }
        await adapter.write(artifact(journal, "commit"), serialized);
        await adapter.rename(artifact(journal, "commit"), committedPath);
        committed = true;
        await cleanCommitted(adapter, journal);
    } catch (error) {
        if (committed) throw new CommentStorageCommitError("Comments saved; backup cleanup must be retried", true, error);
        try {
            // A rename may have succeeded before its promise rejected.
            if (await adapter.exists(committedPath)) {
                const saved = parseJournal(await adapter.read(committedPath), dataFolder);
                if (JSON.stringify(saved) !== JSON.stringify(journal)) throw new Error("Conflicting committed journal");
                committed = true;
            } else if (published || await adapter.exists(pendingPath)) {
                const saved = parseJournal(await adapter.read(pendingPath), dataFolder);
                if (JSON.stringify(saved) !== JSON.stringify(journal)) throw new Error("Conflicting pending journal");
                await rollback(adapter, journal);
            } else {
                await removeIfPresent(adapter, artifact(journal, "journal"));
            }
        } catch (recoveryError) {
            throw new CommentStorageCommitError("Comment transaction failed; recovery must be retried", committed, error, recoveryError);
        }
        throw new CommentStorageCommitError(committed ? "Comments saved; backup cleanup must be retried" : "Comment transaction rolled back", committed, error);
    }
}
