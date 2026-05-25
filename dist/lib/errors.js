// All command-level user-visible errors flow through AgentqError.
// Anything else is treated as an unexpected internal error and printed with
// stack trace.
export class AgentqError extends Error {
    hint;
    constructor(message, hint) {
        super(message);
        this.name = 'AgentqError';
        this.hint = hint;
    }
}
//# sourceMappingURL=errors.js.map