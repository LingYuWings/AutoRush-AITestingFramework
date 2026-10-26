"""Bounded previous HTTP outputs; no invented screenshot or response."""
from autorush.agent.observers import AgentObserver


class ApiObserver(AgentObserver):
    kind='api'
