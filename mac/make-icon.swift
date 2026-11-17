import AppKit
import Foundation

let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let sizes = [16, 32, 128, 256, 512]
for size in sizes {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSColor(calibratedRed: 0.086, green: 0.094, blue: 0.106, alpha: 1).setFill()
        let p = CGFloat(pixels)
        NSBezierPath(roundedRect: NSRect(x: p * 0.06, y: p * 0.06, width: p * 0.88, height: p * 0.88), xRadius: p * 0.20, yRadius: p * 0.20).fill()
        let cyan = NSColor(calibratedRed: 0.388, green: 0.847, blue: 0.902, alpha: 1)
        cyan.setStroke()
        let orbit = NSBezierPath()
        for index in 0..<72 {
            let angle = Double(index) * Double.pi / 36
            let x = p * 0.32 * CGFloat(cos(angle)), y = p * 0.18 * CGFloat(sin(angle))
            let point = NSPoint(x: p * 0.5 + x * 0.8660254 - y * 0.5, y: p * 0.5 + x * 0.5 + y * 0.8660254)
            if index == 0 { orbit.move(to: point) } else { orbit.line(to: point) }
        }
        orbit.close()
        orbit.lineWidth = p / 32
        orbit.stroke()
        cyan.setFill()
        let pulse = NSBezierPath()
        let points: [(CGFloat, CGFloat)] = [(0.50,0.12),(0.56,0.44),(0.88,0.50),(0.56,0.56),(0.50,0.88),(0.44,0.56),(0.12,0.50),(0.44,0.44)]
        pulse.move(to: NSPoint(x: p * points[0].0, y: p * points[0].1))
        for point in points.dropFirst() { pulse.line(to: NSPoint(x: p * point.0, y: p * point.1)) }
        pulse.close()
        pulse.fill()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
    }
}
