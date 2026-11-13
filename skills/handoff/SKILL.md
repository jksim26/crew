---
name: handoff
description: Close out a working session cleanly - save open questions and decisions to the role's memory file, file anything that needs building as a proposal issue, release the dispatcher lease, then tell the owner the session can be closed. Use for "/crew:handoff", "wrap up", "hand off", "I'm done for today", or before closing a role session.
---

# Hand off and close

A session is opened, used and closed. This skill makes closing safe, so nothing lives only in
this conversation.

1. **Find the role and its memory file.** Run `crew roles` to list the project's roles and
   memory files. Use the role the owner named, or the one this session has been working as. If
   unclear, ask once.

2. **Write the handoff** at the top of that memory file (create it if missing), under a dated
   heading `## Handoff YYYY-MM-DD`, at most ~15 lines:
   - what was decided this session (with the reason, one line each)
   - open questions, and who answers each one
   - what to pick up next time, with file paths or PR/issue links
   Do not copy the conversation. Do not write secrets.

3. **File work instead of holding it.** For each thing that needs building that this session did
   not finish, run `crew queue new --title "<short imperative title>" --body-file -` with the
   context, acceptance criteria and links on stdin. These are filed as `needs-jk` proposals. Never
   label anything `ready`: only the owner does that.

4. **Release the lease** if this session took one: `crew lease off`.

5. **Free this session's files:** run `crew sessions clear <id>`, using the `crew session id`
   given at session start. Dev builds that touch the files you edited wait until you do, or until
   the session closes or goes quiet for 2 hours.

6. **Commit the memory file** if the owner's workflow commits from sessions (say what you
   changed). Otherwise leave it for them, and say so.

7. **Tell the owner in 3 lines or fewer**: what was saved where, which issues were filed (links),
   and that the session can be closed. If they want the context smaller before continuing,
   suggest `/compact`.
