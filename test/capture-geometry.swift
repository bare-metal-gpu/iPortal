import AVFoundation
import Foundation

private final class Counter: @unchecked Sendable {
    var value = 0
}

private func sample(_ width: Int, _ height: Int) -> CMSampleBuffer {
    var pixel: CVPixelBuffer?
    precondition(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, nil, &pixel) == noErr)
    var format: CMVideoFormatDescription?
    precondition(CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: pixel!, formatDescriptionOut: &format) == noErr)
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 60), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
    var result: CMSampleBuffer?
    precondition(CMSampleBufferCreateReadyWithImageBuffer(allocator: nil, imageBuffer: pixel!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &result) == noErr)
    return result!
}

@main
struct CaptureGeometryTests {
    static func main() {
        let lifetime = CaptureLifetime(), store = FrameStore(lifetime: CaptureLifetime())
        let events = Counter(), fresh = Counter()
        store.observeGeometry { events.value += 1 }
        store.arm { fresh.value += 1 }
        store.consume(sample(40, 80))
        assert(events.value == 1 && fresh.value == 1)
        assert(store.takeGeometry() == CGSize(width: 40, height: 80))
        store.consume(sample(40, 80))
        assert(events.value == 1, "steady frames must not flood the main queue")
        store.consume(sample(80, 40))
        store.consume(sample(40, 80))
        store.consume(sample(80, 40))
        assert(events.value == 2, "rapid rotations coalesce while the main queue is busy")
        assert(store.takeGeometry() == CGSize(width: 80, height: 40), "the event reports the newest frame, not the first queued size")
        store.clear()
        store.consume(sample(80, 40))
        assert(events.value == 3, "a fresh capture reports geometry even in the same orientation")
        let cancelled = FrameStore(lifetime: lifetime)
        cancelled.observeGeometry { events.value += 1 }
        lifetime.cancel()
        cancelled.consume(sample(40, 80))
        assert(events.value == 3 && cancelled.lastFrameAt == 0, "retired capture cannot rotate a replacement window")
        print("Frame geometry events, coalescing, restart and cancellation tests passed.")
    }
}
