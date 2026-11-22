export const parked = [
  "run:",
  "  id: \"01RUN\"",
  "  branch: orc/test",
  "  status: awaiting_approval",
  "  awaiting_agent: parked 2m10s",
  "  head: abc1234",
  "  pr: \"\"",
  "  findings[2]{id,severity,file,line,action,description}:",
  "    r1,warning,a.go,,auto-fix,ignored error",
  "    r2,error,b.go,,ask-user,changes product behavior",
  "gate: review"
].join("\n")
