// Regenerates narration-widths.json: every header narration line in every
// locale, measured with CoreText in the system font at 14pt, the size the
// Dashboard's status row draws it at. macOS and iOS share the SF face and the
// same font fallback for the other scripts, so this is a real measurement of
// the shaped string, not a per-character estimate.
//
//   swift components/custom/for-you/__tests__/fixtures/measure-narration.swift \
//     lib/locales 14 > components/custom/for-you/__tests__/fixtures/narration-widths.json
//
// Run it after any change to `headerNarration` copy; the test refuses a
// dictionary line the fixture does not carry verbatim.
import AppKit
import CoreText
import Foundation

let args = CommandLine.arguments
let dir = args[1]
let size = CGFloat(Double(args[2]) ?? 14)
let font = NSFont.systemFont(ofSize: size)

func width(_ s: String) -> Double {
  let attr = NSAttributedString(string: s, attributes: [.font: font])
  let line = CTLineCreateWithAttributedString(attr)
  return Double(CTLineGetTypographicBounds(line, nil, nil, nil))
}

let files = try FileManager.default.contentsOfDirectory(atPath: dir)
  .filter { $0.range(of: "^[a-zA-Z-]+\\.json$", options: .regularExpression) != nil }
  .sorted()
var out: [String: Any] = ["_fontSize": Double(size)]
for f in files {
  let data = try Data(contentsOf: URL(fileURLWithPath: dir + "/" + f))
  let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
  guard let h = json["headerNarration"] as? [String: Any] else { continue }
  var rows: [[String: Any]] = []
  if let stages = h["stages"] as? [String: Any] {
    for (k, v) in stages {
      for (i, s) in (v as! [String]).enumerated() {
        rows.append(["key": "stages.\(k)", "index": i, "text": s, "width": (width(s) * 10).rounded() / 10])
      }
    }
  }
  for (i, s) in (h["nudges"] as! [String]).enumerated() {
    rows.append(["key": "nudges", "index": i, "text": s, "width": (width(s) * 10).rounded() / 10])
  }
  out[String(f.dropLast(5))] = rows.sorted {
    ($0["key"] as! String, $0["index"] as! Int) < ($1["key"] as! String, $1["index"] as! Int)
  }
}
let o = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
FileHandle.standardOutput.write(o)
