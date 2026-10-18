"""Runtime context: the dependencies a graph run needs.

Declared as the graph's `context_schema` and passed per invocation
(`graph.ainvoke(..., context=ctx)`). Tools read it via `runtime.context`.
It holds services, not prompt content, so it's never shown to the model.
"""

from dataclasses import dataclass
from typing import Annotated, ClassVar

from pydantic import ConfigDict
from pydantic.json_schema import SkipJsonSchema

from src.db import ReviewsDB


@dataclass(frozen=True)
class AgentContext:
    # LangGraph and ag-ui-langgraph describe the context schema with Pydantic.
    # A DB handle is an arbitrary type, validated with isinstance only.
    __pydantic_config__: ClassVar[ConfigDict] = ConfigDict(arbitrary_types_allowed=True)

    # SkipJsonSchema: ag-ui-langgraph introspects the context schema as JSON
    # Schema on every run, and a live DB handle has no JSON representation.
    db: Annotated[ReviewsDB, SkipJsonSchema()]
