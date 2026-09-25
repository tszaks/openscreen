import CursorKit
import OpenScreenCore
import Testing

@Suite("CursorSmoother")
struct CursorSmootherTests {
    @Test func resamplesPathAtFixedStep() {
        let samples = stride(from: 0.0, through: 1.0, by: 0.25).map {
            CursorSample(time: $0, x: $0, y: 0)
        }
        let smoother = CursorSmoother(step: 0.1)
        let out = smoother.smoothedPath(from: samples)
        #expect(out.count >= 10)
        #expect(out.first?.time == 0)
        #expect(abs((out.last?.time ?? -1) - 1.0) < 0.15)
    }

    @Test func clickEventsArePreserved() {
        var samples = stride(from: 0.0, through: 1.0, by: 0.1).map {
            CursorSample(time: $0, x: $0, y: 0)
        }
        samples.append(CursorSample(time: 0.5, x: 0.5, y: 0, kind: .clickDown))
        samples.append(CursorSample(time: 0.55, x: 0.5, y: 0, kind: .clickUp))
        let out = CursorSmoother().smoothedPath(from: samples)
        #expect(out.contains { $0.kind == .clickDown })
        #expect(out.contains { $0.kind == .clickUp })
    }

    @Test func emptyAndSingleSample() {
        let smoother = CursorSmoother()
        #expect(smoother.smoothedPath(from: []).isEmpty)
        let one = [CursorSample(time: 0, x: 0.3, y: 0.7)]
        #expect(smoother.smoothedPath(from: one).count == 1)
    }
}

@Suite("ZoomPlanner")
struct ZoomPlannerTests {
    @Test func singleClickProducesInOutPair() {
        let clicks = [CursorSample(time: 2.0, x: 0.4, y: 0.6, kind: .clickDown)]
        let keys = ZoomPlanner().plan(clicks: clicks, duration: 8.0)
        let zoomed = keys.filter { $0.scale > 1.5 }
        #expect(zoomed.count == 1)
        #expect(abs(zoomed[0].center.x - 0.4) < 0.01)
        // Bookends at scale 1
        #expect(keys.first?.scale == 1.0)
        #expect(keys.last?.scale == 1.0)
    }

    @Test func nearbyClicksCluster() {
        let clicks = [
            CursorSample(time: 1.0, x: 0.40, y: 0.40, kind: .clickDown),
            CursorSample(time: 1.5, x: 0.45, y: 0.42, kind: .clickDown),
        ]
        let planner = ZoomPlanner(clusterGap: 2.0, mergeRadius: 0.1)
        let keys = planner.plan(clicks: clicks, duration: 6.0)
        #expect(keys.filter { $0.scale > 1.5 }.count == 1)
    }

    @Test func distantClicksStaySeparate() {
        let clicks = [
            CursorSample(time: 1.0, x: 0.2, y: 0.2, kind: .clickDown),
            CursorSample(time: 4.0, x: 0.8, y: 0.8, kind: .clickDown),
        ]
        let keys = ZoomPlanner().plan(clicks: clicks, duration: 8.0)
        #expect(keys.filter { $0.scale > 1.5 }.count == 2)
    }

    @Test func noClicksMeansNoZoom() {
        let keys = ZoomPlanner().plan(clicks: [], duration: 5.0)
        #expect(keys.allSatisfy { $0.scale == 1.0 })
    }
}
