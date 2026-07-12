import AVFoundation
import Foundation
import Speech

struct HelperResponse: Encodable {
    let ok: Bool
    let text: String?
    let error: String?
    let partial: Bool?
}

func emit(_ response: HelperResponse) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(response) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    fflush(stdout)
}

func respond(_ response: HelperResponse, code: Int32 = 0) -> Never {
    emit(response)
    exit(code)
}

func requestPermissions(_ completion: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { speechStatus in
        guard speechStatus == .authorized else {
            DispatchQueue.main.async { completion(false) }
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { microphoneAllowed in
            DispatchQueue.main.async { completion(microphoneAllowed) }
        }
    }
}

final class DictationSession {
    private let audioEngine = AVAudioEngine()
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private var latestText = ""
    private var lastPartialText = ""
    private var stopping = false

    func start() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable else {
            respond(HelperResponse(ok: false, text: nil, error: "Speech recognition is unavailable.", partial: nil), code: 2)
        }

        request.shouldReportPartialResults = true
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [request] buffer, _ in
            request.append(buffer)
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.latestText = result.bestTranscription.formattedString
                let partialText = self.latestText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !result.isFinal && !partialText.isEmpty && partialText != self.lastPartialText {
                    self.lastPartialText = partialText
                    emit(HelperResponse(
                        ok: true,
                        text: partialText,
                        error: nil,
                        partial: true
                    ))
                }
                if result.isFinal { self.complete() }
            } else if error != nil && !self.stopping {
                respond(HelperResponse(ok: false, text: nil, error: "Transcription failed.", partial: nil), code: 3)
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            respond(HelperResponse(ok: false, text: nil, error: "Microphone capture failed.", partial: nil), code: 4)
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            _ = readLine()
            DispatchQueue.main.async { self?.stop() }
        }
    }

    private func stop() {
        guard !stopping else { return }
        stopping = true
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            self?.complete()
        }
    }

    private func complete() {
        task?.cancel()
        let text = latestText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            respond(HelperResponse(ok: false, text: nil, error: "No speech was recognized.", partial: nil), code: 5)
        }
        respond(HelperResponse(ok: true, text: text, error: nil, partial: false))
    }
}

var activeSession: DictationSession?

requestPermissions { allowed in
    guard allowed else {
        respond(HelperResponse(
            ok: false,
            text: nil,
            error: "Microphone and Speech Recognition permission are required.",
            partial: nil
        ), code: 1)
    }
    activeSession = DictationSession()
    activeSession?.start()
}

RunLoop.main.run()
