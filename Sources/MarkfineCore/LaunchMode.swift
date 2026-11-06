import Foundation

public enum LaunchMode: Equatable {
    case interactive

    public static func parse(_ arguments: [String], packaged: Bool) throws -> LaunchMode {
        switch arguments {
        case [] where packaged: return .interactive
        default: throw LaunchFailure.unsupportedArguments
        }
    }
}

public enum LaunchFailure: Error, CustomStringConvertible {
    case unsupportedArguments

    public var description: String {
        "拒绝启动：请打开完整的 Markfine.app。裸可执行文件或未知参数不会启动应用。"
    }
}
