"""Identity-bound window image coordinates."""
from autorush.agent.observers import AgentObserver


# Provide the desktop-specific identity for shared agent observation.
class DesktopObserver(AgentObserver):
    kind='desktop'
