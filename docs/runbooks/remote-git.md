# Remote Git outage

Local commits remain authoritative and intact during a remote outage. Fetch without merging, report the degraded remote state, and retry the explicit push through the expected-head compare-and-swap lease after connectivity returns.
