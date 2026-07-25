/**
 * Safe accessors for the build-time git constants injected by webpack's DefinePlugin
 * (see webpack.renderer.config.js). Outside a webpack bundle (jest, ts-node) the
 * identifiers don't exist at all, so a bare reference throws ReferenceError — every
 * read goes through `typeof` here and degrades to null.
 */

function readString(read: () => string): string | null {
    try {
        const v = read();
        return typeof v === 'string' && v ? v : null;
    } catch {
        return null;
    }
}

export interface BuildInfo {
    sha: string | null;
    branch: string | null;
    subject: string | null;
    dirty: boolean;
    time: string | null;
}

export function getBuildInfo(): BuildInfo {
    return {
        sha: readString(() => (typeof __GIT_SHA__ === 'undefined' ? '' : __GIT_SHA__)),
        branch: readString(() => (typeof __GIT_BRANCH__ === 'undefined' ? '' : __GIT_BRANCH__)),
        subject: readString(() => (typeof __GIT_SUBJECT__ === 'undefined' ? '' : __GIT_SUBJECT__)),
        dirty: typeof __GIT_DIRTY__ !== 'undefined' && __GIT_DIRTY__ === true,
        time: readString(() => (typeof __BUILD_TIME__ === 'undefined' ? '' : __BUILD_TIME__)),
    };
}
