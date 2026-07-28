# Security and incident response

Never place credentials, private brain content, or raw webhook payloads in logs or reports. Revoke the affected token/client, disable writes, preserve the Git commit and audit receipt, rotate the secret, and re-enable only after a scoped verification.

Remote callers must use a confined upload object or content stream. They must never provide an arbitrary local path.
