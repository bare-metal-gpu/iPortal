// Optional benchmark worker: JPEG/PNG -> central 64x96 RGB sample.
// Framed input keeps native image decoding off the Bun timing/event loop.
import Foundation
import ImageIO
import CoreGraphics

let input = FileHandle.standardInput, output = FileHandle.standardOutput
func readExactly(_ length: Int) throws -> Data? {
    var result = Data()
    while result.count < length {
        guard let part = try input.read(upToCount: length - result.count), !part.isEmpty else {
            if result.isEmpty { return nil }
            throw NSError(domain: "iPortalBenchmark", code: 1)
        }
        result.append(part)
    }
    return result
}
while let header = try readExactly(4) {
    let length = header.enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
    guard length > 0, length <= 32 * 1024 * 1024, let bytes = try readExactly(length),
          let source = CGImageSourceCreateWithData(bytes as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          let crop = image.cropping(to: CGRect(x: Double(image.width) * 0.1, y: Double(image.height) * 0.18,
                                              width: Double(image.width) * 0.8, height: Double(image.height) * 0.62)) else {
        throw NSError(domain: "iPortalBenchmark", code: 2)
    }
    var rgba = [UInt8](repeating: 0, count: 64 * 96 * 4)
    try rgba.withUnsafeMutableBytes { pixels in
        guard let context = CGContext(data: pixels.baseAddress, width: 64, height: 96, bitsPerComponent: 8,
                                      bytesPerRow: 64 * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw NSError(domain: "iPortalBenchmark", code: 3)
        }
        context.interpolationQuality = .high
        context.draw(crop, in: CGRect(x: 0, y: 0, width: 64, height: 96))
    }
    var rgb = Data(capacity: 64 * 96 * 3)
    for offset in stride(from: 0, to: rgba.count, by: 4) { rgb.append(contentsOf: rgba[offset..<(offset + 3)]) }
    try output.write(contentsOf: rgb)
}
