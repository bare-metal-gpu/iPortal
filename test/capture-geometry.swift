import AVFoundation
import Cocoa
import Foundation

private final class Counter: @unchecked Sendable {
    var value = 0
}

private func sample(_ width: Int, _ height: Int, pixelFormat: OSType = kCVPixelFormatType_32BGRA) -> CMSampleBuffer {
    var pixel: CVPixelBuffer?
    precondition(CVPixelBufferCreate(nil, width, height, pixelFormat, nil, &pixel) == noErr)
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
        var gate = CapturePresentationGate()
        let waitingStore = FrameStore(lifetime: CaptureLifetime())
        waitingStore.consume(portrait)
        assert(gate.next(ready: false, requiresFlush: false, failed: false, hasFrame: waitingStore.hasPendingFrame) == .wait(1))
        waitingStore.consume(landscape)
        assert(gate.next(ready: false, requiresFlush: false, failed: false, hasFrame: waitingStore.hasPendingFrame) == .none,
               "backpressure arms one readiness subscription")
        assert(waitingStore.hasPendingFrame, "backpressure must retain the final update when capture becomes idle")
        assert(gate.next(ready: true, requiresFlush: false, failed: false, hasFrame: waitingStore.hasPendingFrame) == .present)
        assert(waitingStore.takeFrame()?.sample === landscape,
               "readiness presents only the newest pixels and matching geometry")
        assert(gate.next(ready: false, requiresFlush: false, failed: false, hasFrame: false) == .none,
               "an empty queue must not leave a readiness subscription armed")
        waitingStore.consume(portrait)
        assert(gate.next(ready: false, requiresFlush: false, failed: false, hasFrame: true) == .wait(2),
               "new frames can rearm after the queue was empty")
        assert(!gate.rendererCallback(1), "old readiness callbacks cannot cancel a replacement subscription")
        assert(gate.rendererCallback(2))
        assert(gate.next(ready: false, requiresFlush: false, failed: false, hasFrame: true) == .wait(3),
               "a readiness race must rearm rather than strand the final frame")
        assert(gate.next(ready: true, requiresFlush: true, failed: true, hasFrame: true) == .flush(1))
        assert(gate.next(ready: true, requiresFlush: false, failed: false, hasFrame: true) == .none,
               "no enqueue may race an asynchronous flush")
        waitingStore.consume(landscape)
        assert(!gate.flushed(0), "obsolete flush callbacks cannot release ownership")
        assert(gate.flushed(1))
        assert(gate.next(ready: true, requiresFlush: false, failed: false, hasFrame: true) == .present)
        assert(waitingStore.takeFrame()?.sample === landscape, "flush recovery retains the newest pending update")
        assert(gate.next(ready: false, requiresFlush: true, failed: true, hasFrame: false) == .flush(2))
        assert(gate.flushed(2))
        assert(gate.next(ready: false, requiresFlush: true, failed: true, hasFrame: false) == .fail,
               "repeated renderer faults escalate instead of looping")
        assert(gate.next(ready: true, requiresFlush: false, failed: false, hasFrame: true) == .none)
        var retiredGate = CapturePresentationGate()
        assert(retiredGate.next(ready: false, requiresFlush: true, failed: true, hasFrame: true) == .flush(1))
        retiredGate.stop()
        assert(!retiredGate.flushed(1), "a stopped capture ignores its pending flush callback")
        assert(retiredGate.next(ready: true, requiresFlush: false, failed: false, hasFrame: true) == .none)
        var stalledGate = CapturePresentationGate()
        assert(stalledGate.next(ready: false, requiresFlush: true, failed: true, hasFrame: true) == .flush(1))
        assert(!stalledGate.flushTimedOut(0))
        assert(stalledGate.flushTimedOut(1), "a native flush stall must escalate to the capture owner")
        assert(!stalledGate.flushed(1), "a late completion cannot revive a timed-out renderer")

        let limited = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        let full = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        let bgra = kCVPixelFormatType_32BGRA
        let sdr = kCVImageBufferTransferFunction_ITU_R_709_2 as String
        assert(CapturePixelFormat.preferred(available: [bgra, full, limited], source: full, transferFunction: sdr) == full,
               "native full-range capture must retain its range")
        assert(CapturePixelFormat.preferred(available: [limited, full], source: limited,
            transferFunction: kCVImageBufferTransferFunction_sRGB as String) == limited,
               "native video-range SDR remains available without BGRA")
        assert(CapturePixelFormat.preferred(available: [bgra, full, limited], source: bgra) == bgra,
               "a native BGRA source should not be converted into YUV")
        assert(CapturePixelFormat.preferred(available: [bgra, limited], source: kCMVideoCodecType_H264) == bgra,
               "advertised YUV does not establish a compressed source's bit depth or transfer")
        assert(CapturePixelFormat.preferred(available: [bgra, limited], source: kCMVideoCodecType_H264,
            bitsPerComponent: 8, transferFunction: sdr) == limited,
               "confirmed eight-bit SDR may use an advertised YUV output")
        for source in [full, kCMVideoCodecType_HEVC] {
            for (depth, transfer) in [(10, sdr), (8, kCVImageBufferTransferFunction_ITU_R_2100_HLG as String),
                                      (10, kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ as String), (8, "unknown")] {
                assert(CapturePixelFormat.preferred(available: [limited, full, bgra], source: source,
                    bitsPerComponent: depth, transferFunction: transfer) == bgra,
                       "deep, HDR and unknown transfer functions must retain the baseline conversion")
            }
        }
        assert(CapturePixelFormat.preferred(available: [bgra, full], source: full) == bgra,
               "raw eight-bit layout alone does not prove SDR")
        assert(CapturePixelFormat.preferred(available: [bgra, limited], source: kCMVideoCodecType_HEVC,
            transferFunction: sdr) == bgra, "SDR transfer alone does not establish compressed bit depth")
        assert(CapturePixelFormat.preferred(available: [limited], source: kCMVideoCodecType_HEVC) == nil,
               "unknown sources without BGRA retain the safe uncompressed-default fallback")
        assert(CapturePixelFormat.preferred(available: [bgra, limited], source: full, transferFunction: sdr) == limited,
               "confirmed SDR can choose an advertised alternate range when native range is unavailable")
        assert(CapturePixelFormat.preferred(available: [bgra], source: full) == bgra,
               "unsupported native format retains the established BGRA path")
        assert(CapturePixelFormat.preferred(available: [], source: full) == nil,
               "empty capabilities must not force an unsupported output")
        for format in [limited, full] {
            let yuv = sample(80, 40, pixelFormat: format)
            let image = CMSampleBufferGetImageBuffer(yuv)!
            CVPixelBufferLockBaseAddress(image, [])
            for plane in 0..<CVPixelBufferGetPlaneCount(image) {
                CVPixelBufferGetBaseAddressOfPlane(image, plane)!.initializeMemory(as: UInt8.self,
                    repeating: plane == 0 ? (format == limited ? 235 : 255) : 128,
                    count: CVPixelBufferGetBytesPerRowOfPlane(image, plane) * CVPixelBufferGetHeightOfPlane(image, plane))
            }
            CVPixelBufferUnlockBaseAddress(image, [])
            waitingStore.consume(yuv)
            assert(waitingStore.takeFrame()?.size == CGSize(width: 80, height: 40))
            let snapshot = waitingStore.snapshot()!
            var proposed = CGRect(x: 0, y: 0, width: 80, height: 40)
            let cg = snapshot.cgImage(forProposedRect: &proposed, context: nil, hints: nil)!
            let bitmap = NSBitmapImageRep(cgImage: cg)
            let color = bitmap.colorAt(x: 40, y: 20)!.usingColorSpace(.deviceRGB)!
            assert(color.redComponent > 0.96 && color.greenComponent > 0.96 && color.blueComponent > 0.96,
                   "snapshot conversion must preserve full/video-range white for \(format)")
        }
        print("Frame/geometry pairing, coalescing, immediate display and cancellation tests passed.")
        print("Renderer backpressure, idle final frame, bounded flush recovery and YUV snapshot tests passed.")
    }
}
