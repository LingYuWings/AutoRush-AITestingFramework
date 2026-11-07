"""Bounded previous HTTP outputs; no invented screenshot or response."""
from autorush.agent.observers import AgentObserver


# Provide the API-specific identity for shared agent observation.
class ApiObserver(AgentObserver):
    kind='api'
