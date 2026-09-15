# Windows power and lock settings

The bot and scheduler each start an independent PowerShell helper that calls `SetThreadExecutionState`. Either process can keep the system awake; stopping one does not cancel the other's request. Each helper watches its parent PID, releases its request, and exits if the parent terminates. This does not permanently alter the Windows power plan.

Keep-awake does not guarantee an unlocked desktop. Screen saver settings, Dynamic Lock, lid-close behavior, battery rules, and organization-managed inactivity policies may still lock or sleep the machine. The application respects manual locking and never simulates input, unlocks Windows, or overrides managed policy.

Recommended deployment allows screen locking while preventing idle sleep. Test WMS extraction from the authenticated Chrome session while locked. If that fails, record an unlocked interactive Windows session as a deployment dependency and obtain approval for any policy change.
