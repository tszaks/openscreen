import AVFoundation
import Foundation
import OpenScreenCore
import Speech

/// On-device transcription → caption cues, plus SRT/VTT sidecar writers.
public struct Captioner: Sendable {
    public init() {}

    /// Transcribe an audio/video file into timed cues via Speech.framework.
    /// Returns empty when speech recognition is unavailable/denied.
    public func transcribe(url: URL, locale: Locale = .current) async -> [CaptionCue] {
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else { return [] }
        let status = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0) }
        }
        guard status == .authorized else { return [] }

        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        request.addsPunctuation = true

        return await withCheckedContinuation { cont in
            var cues: [CaptionCue] = []
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                if finished { return }
                if error == nil, let result, result.isFinal {
                    for segment in result.bestTranscription.segments {
                        cues.append(CaptionCue(
                            start: segment.timestamp,
                            end: segment.timestamp + segment.duration,
                            text: segment.substring
                        ))
                    }
                }
                if error != nil || (result?.isFinal == true) {
                    finished = true
                    cont.resume(returning: cues)
                }
            }
        }
    }
}

/// Sidecar writers — `.srt` for players, `.vtt` for web.
public enum CaptionWriter {
    public static func srt(_ cues: [CaptionCue]) -> String {
        cues.enumerated().map { idx, cue in
            """
            \(idx + 1)
            \(stamp(cue.start)) --> \(stamp(cue.end))
            \(cue.text)

            """
        }.joined()
    }

    public static func vtt(_ cues: [CaptionCue]) -> String {
        "WEBVTT\n\n" + cues.map { cue in
            "\(stamp(cue.start)) --> \(stamp(cue.end))\n\(cue.text)\n"
        }.joined(separator: "\n")
    }

    private static func stamp(_ t: TimeInterval) -> String {
        let ms = Int((t * 1000).rounded())
        return String(format: "%02d:%02d:%02d,%03d", ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
    }
}
