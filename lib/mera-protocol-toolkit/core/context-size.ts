// llama.rn context size for every on-device call, in its own import-free module
// so prompt builders can read it without loading llama.rn.
//
// With `ctx_shift` off, llama.rn answers a prompt that does not fit with EMPTY
// text and no error. That is how the local relevance pass once scored nothing
// for two months without a single recorded failure, so anything that builds a
// local prompt checks it against this number first.
export const LOCAL_CONTEXT_TOKENS = 4096;
