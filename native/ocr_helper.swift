import Foundation
import PDFKit
import Vision
import AppKit

struct OcrPage: Codable {
    let pageNumber: Int
    let text: String
}

struct OcrResult: Codable {
    let pages: [OcrPage]
}

enum OcrError: Error {
    case invalidArguments
    case cannotOpenPdf
    case cannotRenderPage(Int)
}

func run() throws {
    let arguments = CommandLine.arguments
    guard arguments.count >= 2 else {
        throw OcrError.invalidArguments
    }

    let filePath = arguments[1]
    guard let document = PDFDocument(url: URL(fileURLWithPath: filePath)) else {
        throw OcrError.cannotOpenPdf
    }

    let pageRange: ClosedRange<Int>
    if arguments.count >= 4, let start = Int(arguments[2]), let end = Int(arguments[3]), start >= 1, end >= start {
        pageRange = start...min(end, document.pageCount)
    } else {
        pageRange = 1...document.pageCount
    }

    var pages: [OcrPage] = []

    for pageNumber in pageRange {
      guard let page = document.page(at: pageNumber - 1) else {
        continue
      }

      let bounds = page.bounds(for: .mediaBox)
      let scale: CGFloat = 2.0
      let imageSize = NSSize(width: max(bounds.width * scale, 1), height: max(bounds.height * scale, 1))
      let image = NSImage(size: imageSize)
      image.lockFocus()
      NSColor.white.set()
      NSRect(origin: .zero, size: imageSize).fill()
      let context = NSGraphicsContext.current?.cgContext
      context?.scaleBy(x: scale, y: scale)
      page.draw(with: .mediaBox, to: context!)
      image.unlockFocus()

      guard let tiffData = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiffData),
            let cgImage = bitmap.cgImage else {
          throw OcrError.cannotRenderPage(pageNumber)
      }

      let request = VNRecognizeTextRequest()
      request.recognitionLevel = .accurate
      request.usesLanguageCorrection = true
      request.recognitionLanguages = ["en-US", "zh-Hans", "ja-JP"]

      let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
      try handler.perform([request])

      let text = (request.results ?? [])
          .compactMap { observation in
              observation.topCandidates(1).first?.string
          }
          .joined(separator: "\n")
          .trimmingCharacters(in: .whitespacesAndNewlines)

      pages.append(OcrPage(pageNumber: pageNumber, text: text))
    }

    let result = OcrResult(pages: pages)
    let data = try JSONEncoder().encode(result)
    FileHandle.standardOutput.write(data)
}

do {
    try run()
} catch {
    let message = String(describing: error)
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
