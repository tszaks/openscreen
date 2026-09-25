import EditKit
import OpenScreenCore
import Testing

@Suite("Timeline")
struct TimelineTests {
    @Test func defaultTimelineIsOneClip() {
        let tl = Timeline(sourceDuration: 10)
        #expect(tl.clips.count == 1)
        #expect(tl.outputDuration == 10)
    }

    @Test func splitProducesTwoClips() {
        var tl = Timeline(sourceDuration: 10)
        let didSplit = tl.split(at: 4)
        #expect(didSplit)
        #expect(tl.clips.count == 2)
        #expect(tl.clips[0].sourceEnd == 4)
        #expect(tl.clips[1].sourceStart == 4)
        #expect(tl.outputDuration == 10)
    }

    @Test func splitAtBoundaryFails() {
        var tl = Timeline(sourceDuration: 10)
        let atStart = tl.split(at: 0)
        let atEnd = tl.split(at: 10)
        #expect(!atStart)
        #expect(!atEnd)
        #expect(tl.clips.count == 1)
    }

    @Test func splitInsideSpedUpClipMapsSourceTime() {
        var tl = Timeline(sourceDuration: 20)
        tl.setSpeed(clipID: tl.clips[0].id, speed: 2)
        #expect(tl.outputDuration == 10)
        let didSplit = tl.split(at: 5) // halfway in output = 10s source
        #expect(didSplit)
        #expect(tl.clips[0].sourceEnd == 10)
        #expect(tl.clips[1].sourceStart == 10)
    }

    @Test func trimClampsToSource() {
        var tl = Timeline(sourceDuration: 10)
        let id = tl.clips[0].id
        tl.trim(clipID: id, newSourceStart: -5, newSourceEnd: 99)
        #expect(tl.clips[0].sourceStart == 0)
        #expect(tl.clips[0].sourceEnd == 10)
    }

    @Test func setSpeedClampsAndAdjustsDuration() {
        var tl = Timeline(sourceDuration: 8)
        let id = tl.clips[0].id
        tl.setSpeed(clipID: id, speed: 0.5)
        #expect(tl.outputDuration == 16)
        tl.setSpeed(clipID: id, speed: 100)
        #expect(tl.clips[0].speed == 8) // clamped
    }

    @Test func removeAndMove() {
        var tl = Timeline(sourceDuration: 10)
        tl.split(at: 3)
        tl.split(at: 6)
        #expect(tl.clips.count == 3)
        let thirdID = tl.clips[2].id
        tl.move(clipID: thirdID, to: 0)
        #expect(tl.clips[0].id == thirdID)
        tl.remove(clipID: thirdID)
        #expect(tl.clips.count == 2)
        #expect(tl.outputDuration == 6)
    }

    @Test func outputTimeInvertsSourceTime() {
        let tl = Timeline(sourceDuration: 6, clips: [
            Clip(sourceStart: 0, sourceEnd: 4),
            Clip(sourceStart: 4, sourceEnd: 6, speed: 2),
        ])
        #expect(tl.outputTime(forSourceTime: 2) == 2)
        #expect(tl.outputTime(forSourceTime: 5) == 4.5)
        #expect(tl.outputTime(forSourceTime: 7) == nil) // trimmed away
    }

    @Test func sourceTimeMapsThroughSpeed() {
        var tl = Timeline(sourceDuration: 20)
        tl.setSpeed(clipID: tl.clips[0].id, speed: 2)
        #expect(tl.sourceTime(atOutputTime: 5) == 10)
        #expect(tl.sourceTime(atOutputTime: 10.5) == nil)
    }
}
