from math import isfinite
from typing import Literal, NotRequired, TypedDict


ELEMENT_NAMES = ("title", "message", "logo", "timer", "hints")
HINT_LAYOUTS = ("stacked", "side-by-side", "text-only", "media-only")
RESULT_NAMES = ("complete", "failed")


class LayoutElement(TypedDict):
    x: float
    y: float
    width: float
    height: float
    font_size: float
    align: Literal["left", "center", "right"]
    visible: bool


class ResultLayout(TypedDict):
    elements: dict[str, LayoutElement]


class ScreenLayout(TypedDict):
    version: int
    elements: dict[str, LayoutElement]
    hint_layout: Literal["stacked", "side-by-side", "text-only", "media-only"]
    result_layouts: NotRequired[dict[str, ResultLayout]]


def default_screen_layout() -> ScreenLayout:
    def element(x: float, y: float, width: float, height: float, font: float) -> LayoutElement:
        return {
            "x": x, "y": y, "width": width, "height": height,
            "font_size": font, "align": "center", "visible": True,
        }

    return {
        "version": 1,
        "elements": {
            "title": element(18, 4, 64, 18, 10),
            "message": element(10, 28, 80, 12, 4),
            "logo": element(2, 2, 14, 16, 3),
            "timer": element(10, 42, 80, 20, 12),
            "hints": element(10, 66, 80, 30, 3),
        },
        "hint_layout": "stacked",
    }


def default_result_layouts() -> dict[str, ResultLayout]:
    layouts: dict[str, ResultLayout] = {}
    for name in RESULT_NAMES:
        elements = default_screen_layout()["elements"]
        del elements["hints"]
        for element in elements.values():
            element["visible"] = False
        elements["message"].update(x=5, y=35, width=90, height=30, font_size=8, visible=True)
        layouts[name] = {"elements": elements}
    return layouts


def validate_screen_layout(value: object) -> ScreenLayout:
    required = {"version", "elements", "hint_layout"}
    if not isinstance(value, dict) or set(value) not in (required, required | {"result_layouts"}):
        raise ValueError("A screen layout must contain version, elements, and hint_layout.")
    if type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Unsupported screen layout version.")
    if value["hint_layout"] not in HINT_LAYOUTS:
        raise ValueError("Choose a supported hint layout.")
    validated = default_screen_layout()
    validated["hint_layout"] = value["hint_layout"]
    validated["elements"] = _validate_elements(value["elements"], validated["elements"])
    if "result_layouts" in value:
        results = value["result_layouts"]
        if not isinstance(results, dict) or set(results) != set(RESULT_NAMES):
            raise ValueError("Result layouts must contain complete and failed screens.")
        validated["result_layouts"] = default_result_layouts()
        for name in RESULT_NAMES:
            result = results[name]
            if not isinstance(result, dict) or set(result) != {"elements"}:
                raise ValueError(f"Invalid result layout for {name}.")
            validated["result_layouts"][name]["elements"] = _validate_elements(
                result["elements"], validated["result_layouts"][name]["elements"]
            )
    return validated


def _validate_elements(value: object, defaults: dict[str, LayoutElement]) -> dict[str, LayoutElement]:
    if not isinstance(value, dict) or set(value) != set(defaults):
        raise ValueError("The layout must contain all supported screen elements.")
    validated: dict[str, LayoutElement] = {}
    for name in defaults:
        block = value[name]
        if not isinstance(block, dict) or set(block) != set(defaults[name]):
            raise ValueError(f"Invalid layout properties for {name}.")
        for key in ("x", "y", "width", "height", "font_size"):
            number = block[key]
            if type(number) not in (int, float) or not 0 <= number <= 100 or not isfinite(number):
                raise ValueError(f"{name} {key} must be a finite number.")
        if not (
            0 <= block["x"] <= 95 and 0 <= block["y"] <= 95
            and 5 <= block["width"] <= 100 and 5 <= block["height"] <= 100
            and block["x"] + block["width"] <= 100
            and block["y"] + block["height"] <= 100
            and 0.5 <= block["font_size"] <= 20
        ):
            raise ValueError(f"{name} must fit inside the screen; font size must be 0.5 to 20.")
        if block["align"] not in ("left", "center", "right") or type(block["visible"]) is not bool:
            raise ValueError(f"Invalid alignment or visibility for {name}.")
        validated[name] = {
            "x": float(block["x"]), "y": float(block["y"]),
            "width": float(block["width"]), "height": float(block["height"]),
            "font_size": float(block["font_size"]),
            "align": block["align"], "visible": block["visible"],
        }
    return validated
