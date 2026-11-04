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
        let events = Counter()
        store.observeFrames { events.value += 1 }
        let portrait = sample(40, 80), landscape = sample(80, 40)
        store.consume(portrait)
        assert(events.value == 1)
        let first = store.takeFrame()!
        assert(first.size == CGSize(width: 40, height: 80))
        assert(first.sample === portrait && first.timestamp > 0)
        assert(store.takeFrame() == nil, "a consumed frame must not be replayed")
        store.consume(portrait)
        store.consume(landscape)
        store.consume(portrait)
        store.consume(landscape)
        assert(events.value == 2, "a busy main queue receives one wakeup, not a frame backlog")
        let newest = store.takeFrame()!
        assert(newest.size == CGSize(width: 80, height: 40) && newest.sample === landscape,
               "geometry and pixels must come from the same newest sample")
        assert(CVPixelBufferGetWidth(CMSampleBufferGetImageBuffer(newest.sample)!) == 80)
        let immediate = newest.immediateSample()!
        let attachments = CMSampleBufferGetSampleAttachmentsArray(immediate, createIfNecessary: false)! as NSArray
        assert((attachments[0] as! NSDictionary)[kCMSampleAttachmentKey_DisplayImmediately] as? Bool == true,
               "live presentation cannot accumulate timestamp latency")
        store.consume(portrait)
        store.clear()
        assert(store.takeFrame() == nil, "clearing a capture drops any queued frame")
        store.consume(landscape)
        assert(store.takeFrame()?.size == CGSize(width: 80, height: 40))
        let cancelled = FrameStore(lifetime: lifetime)
        let cancelledEvents = Counter()
        cancelled.observeFrames { cancelledEvents.value += 1 }
        cancelled.consume(portrait)
        lifetime.cancel()
        assert(cancelled.takeFrame() == nil, "already-queued work cannot present after retirement")
        cancelled.consume(landscape)
        assert(cancelledEvents.value == 1, "retired capture cannot enqueue more presentation work")
        print("Frame/geometry pairing, coalescing, immediate display and cancellation tests passed.")
    }
}
