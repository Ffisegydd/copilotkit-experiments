# Prompt

The design of this repo boiled down to one prompt, for an existing app with a database and UI.

> Add an AI assistant to this app as a chat sidebar built with assistant-ui, with the browser talking directly to a Python LangGraph agent over AG-UI. Move the edit form's state into the agent's shared state. The form renders a `draft` from it and writes the user's edits back, so the agent always sees what's on screen. The agent can open records, filter the list, start drafts and fill them in, and its changes go into a separate `proposal` that the form shows as tracked changes for the user to accept or reject. Give the agent a read-only database role, so saving stays with the user and the existing Save button. Keep the agent stateless: the browser holds the conversation and sends it, with the shared state, on every run. Use frontend tools for navigation and backend tools for anything that changes shared state, and have each page tell the agent where the user is.
