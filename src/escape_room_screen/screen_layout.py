from math import isfinite
from typing import Literal, TypedDict


ELEMENT_NAMES = ("title", "message", "logo", "timer", "hints")
HINT_LAYOUTS = ("stacked", "side-by-side", "text-only", "media-only")


class LayoutElement(TypedDict):
    x: float
    y: float
    width: float
    height: float
    font_size: float
    align: Literal["left", "center", "right"]
    visible: bool


class ScreenLayout(TypedDict):
    version: int
    elements: dict[str, LayoutElement]
    hint_layout: Literal["stacked", "side-by-side", "text-only", "media-only"]


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


def validate_screen_layout(value: object) -> ScreenLayout:
    if not isinstance(value, dict) or set(value) != {"version", "elements", "hint_layout"}:
        raise ValueError("A screen layout must contain version, elements, and hint_layout.")
    if type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Unsupported screen layout version.")
    elements = value["elements"]
    if not isinstance(elements, dict) or set(elements) != set(ELEMENT_NAMES):
        raise ValueError("The layout must contain the title, message, logo, timer, and hints.")
    if value["hint_layout"] not in HINT_LAYOUTS:
        raise ValueError("Choose a supported hint layout.")
    validated = default_screen_layout()
    validated["hint_layout"] = value["hint_layout"]
    for name in ELEMENT_NAMES:
        block = elements[name]
        if not isinstance(block, dict) or set(block) != set(validated["elements"][name]):
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
        validated["elements"][name] = {
            "x": float(block["x"]), "y": float(block["y"]),
            "width": float(block["width"]), "height": float(block["height"]),
            "font_size": float(block["font_size"]),
            "align": block["align"], "visible": block["visible"],
        }
    return validated
