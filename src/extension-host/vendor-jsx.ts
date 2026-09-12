/**
 * The entrypoint of the /vendor/react-jsx-runtime.js vendor chunk (src/extension-host/clientChunks.ts).
 *
 * One file exporting both jsx runtimes: the import map points react/jsx-runtime and
 * react/jsx-dev-runtime at the same served chunk, and this is the file that makes that true —
 * whichever of the two an out-of-tree client chunk was transpiled against, its specifiers
 * resolve here. Both names come from the same package internals, so the star re-exports do
 * not collide; they share the jsx and jsxs the development runtime re-exports.
 */
export * from "react/jsx-runtime";
export * from "react/jsx-dev-runtime";
