import Cocoa
import CoreVideo

@main struct MarkerTest {
    static func main() {
        var image: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 200, 400, kCVPixelFormatType_32BGRA, nil, &image) == kCVReturnSuccess)
        let pixel = image!
        CVPixelBufferLockBaseAddress(pixel, [])
        let p = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
        let rowBytes = CVPixelBufferGetBytesPerRow(pixel)
        func draw(_ code: Int, y0: Int, sentinel: Bool = true) {
            memset(p, 0, rowBytes * 400)
            for y in y0..<(y0 + 40) {
                for i in 0..<10 {
                    let rgb: (UInt8, UInt8, UInt8) = i == 0 ? (sentinel ? 255 : 0, 255, 255)
                        : i == 1 ? (0,255,0) : code & (1 << (i-2)) == 0 ? (255,0,0) : (0,255,255)
                    for x in (20 + i*16)..<(36 + i*16) {
                        p[y*rowBytes+x*4] = rgb.2; p[y*rowBytes+x*4+1] = rgb.1
                        p[y*rowBytes+x*4+2] = rgb.0; p[y*rowBytes+x*4+3] = 255
                    }
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(pixel, [])
        for code in 0...255 {
            CVPixelBufferLockBaseAddress(pixel, []); draw(code, y0:128); CVPixelBufferUnlockBaseAddress(pixel, [])
            precondition(MirrorBenchmark.marker(pixel) == code, "Incorrect marker \(code)")
        }
        CVPixelBufferLockBaseAddress(pixel, []); draw(37, y0:160); CVPixelBufferUnlockBaseAddress(pixel, [])
        precondition(MirrorBenchmark.marker(pixel) == 37, "Letterboxed view")
        CVPixelBufferLockBaseAddress(pixel, []); draw(37, y0:160, sentinel:false); CVPixelBufferUnlockBaseAddress(pixel, [])
        precondition(MirrorBenchmark.marker(pixel) == nil, "Invalid sentinel")
        print("All 256 codes, shifted marker, and invalid sentinel passed.")
    }
}
