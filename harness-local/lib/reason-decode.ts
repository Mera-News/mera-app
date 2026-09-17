// harness-local — the pass-2 reason decoder, re-exported under a local name.
//
// This was an ADAPTER while `parseReasonResult` was still landing in
// lib/news-harness; it wrapped `parseReasonResponse` in the final shape so
// every caller in this directory could already code against the object
// contract. That export exists now (geofix2 P2), so the wrapper is gone and
// this is a straight re-export: one name for the runner, one implementation,
// and no second decoder that can drift from the shipped one.
//
// KEEP IT A RE-EXPORT. The whole point of the eval is that it measures the
// SHIPPED decode, not a look-alike written beside it. If this file ever grows
// a rule of its own, the numbers stop being about the product.

export {
  parseReasonResult as decodeReason,
  type ReasonRescore,
} from '../../lib/news-harness';

/** The shape `decodeReason` returns. `rescore` is absent whenever `k`/`s` did
 *  not parse: fail open, the pass-1 score stands. */
export interface DecodedReason {
  reason: string;
  rescore?: import('../../lib/news-harness').ReasonRescore;
}
