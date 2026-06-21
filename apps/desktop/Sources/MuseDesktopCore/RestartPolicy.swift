import Foundation

public enum RestartDecision: Equatable, Sendable {
    case restart(afterSeconds: Double)
    case giveUp
}

/// Decides whether (and after how long) to relaunch the bundled server after it
/// exits unexpectedly: exponential backoff with a cap, plus a circuit breaker so
/// a crash-looping binary backs off fast and then stops hot-spinning. Pure +
/// headless-testable; ServerManager keeps only the Process plumbing.
public struct RestartPolicy: Sendable {
    public let maxRestarts: Int
    public let baseDelay: Double
    public let maxDelay: Double

    public init(maxRestarts: Int = 3, baseDelay: Double = 1.5, maxDelay: Double = 30) {
        self.maxRestarts = max(0, maxRestarts)
        self.baseDelay = max(0, baseDelay)
        self.maxDelay = max(0, maxDelay)
    }

    /// `restartsSoFar` = how many restarts have already happened (0 on the first
    /// unexpected exit). Returns the delay before the next launch, or `.giveUp`
    /// once the breaker trips. Delay = `baseDelay * 2^restartsSoFar`, capped at
    /// `maxDelay`.
    public func decide(restartsSoFar: Int) -> RestartDecision {
        guard restartsSoFar < maxRestarts else { return .giveUp }
        let exp = pow(2, Double(max(0, restartsSoFar)))
        return .restart(afterSeconds: min(maxDelay, baseDelay * exp))
    }
}
