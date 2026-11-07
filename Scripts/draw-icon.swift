// Original vector artwork. Offscreen bitmap drawing only; does not create NSApplication or windows.
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
let graphics = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = graphics
let context = graphics.cgContext
context.setAllowsAntialiasing(true)
let tile = NSBezierPath(roundedRect: NSRect(x: 96, y: 96, width: 832, height: 832), xRadius: 186, yRadius: 186)
context.saveGState(); context.setShadow(offset: CGSize(width: 0, height: -12), blur: 24, color: NSColor.black.withAlphaComponent(0.16).cgColor)
NSColor(srgbRed: 0.91, green: 0.95, blue: 0.91, alpha: 1).setFill(); tile.fill(); context.restoreGState()
NSGradient(starting: NSColor(srgbRed: 0.99, green: 1, blue: 0.98, alpha: 1), ending: NSColor(srgbRed: 0.83, green: 0.91, blue: 0.85, alpha: 1))!.draw(in: tile, angle: -70)
let ribbon = NSBezierPath(); ribbon.lineWidth = 91; ribbon.lineCapStyle = .round; ribbon.lineJoinStyle = .round
ribbon.move(to: NSPoint(x: 300, y: 338)); ribbon.line(to: NSPoint(x: 300, y: 654)); ribbon.line(to: NSPoint(x: 504, y: 446)); ribbon.line(to: NSPoint(x: 670, y: 620)); ribbon.line(to: NSPoint(x: 670, y: 338))
NSColor(srgbRed: 0.12, green: 0.29, blue: 0.22, alpha: 1).setStroke(); ribbon.stroke()
let glint = NSBezierPath(); glint.lineWidth = 15; glint.lineCapStyle = .round; glint.move(to: NSPoint(x: 305, y: 662)); glint.line(to: NSPoint(x: 502, y: 460))
NSColor(srgbRed: 0.43, green: 0.69, blue: 0.53, alpha: 0.55).setStroke(); glint.stroke()
let spark = NSBezierPath(); let x: CGFloat = 730, y: CGFloat = 715
spark.move(to: NSPoint(x:x,y:y+107)); spark.curve(to:NSPoint(x:x+107,y:y), controlPoint1:NSPoint(x:x+17,y:y+25), controlPoint2:NSPoint(x:x+25,y:y+17))
spark.curve(to:NSPoint(x:x,y:y-107), controlPoint1:NSPoint(x:x+25,y:y-17), controlPoint2:NSPoint(x:x+17,y:y-25))
spark.curve(to:NSPoint(x:x-107,y:y), controlPoint1:NSPoint(x:x-17,y:y-25), controlPoint2:NSPoint(x:x-25,y:y-17))
spark.curve(to:NSPoint(x:x,y:y+107), controlPoint1:NSPoint(x:x-25,y:y+17), controlPoint2:NSPoint(x:x-17,y:y+25)); spark.close()
NSGradient(starting: NSColor(srgbRed:0.22,green:0.72,blue:0.48,alpha:1), ending:NSColor(srgbRed:0.08,green:0.4,blue:0.29,alpha:1))!.draw(in:spark,angle:-90)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
