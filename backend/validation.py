"""Validation shared by message creation, layout saves and imports."""
import json
import math
import re
from urllib.parse import urlsplit


def valid_discord_webhook(value):
    if not isinstance(value, str):
        return False
    try:
        url = urlsplit(value)
        return (url.scheme == 'https'
                and url.netloc in ('discord.com', 'discordapp.com')
                and not url.query and not url.fragment
                and re.fullmatch(r'/api(?:/v\d+)?/webhooks/\d+/[A-Za-z0-9_-]+', url.path) is not None)
    except ValueError:
        return False


def positive_id(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def validate_layout(value):
    """Return a layout object, rejecting values that can break the renderer."""
    if value is None:
        return None
    try:
        layout = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError) as exc:
        raise ValueError('Layout must contain valid JSON') from exc
    if not isinstance(layout, dict):
        raise ValueError('Layout must be an object')

    def number(obj, key, low, high):
        if key not in obj:
            return
        n = obj[key]
        if type(n) not in (int, float) or not math.isfinite(n) or not low <= n <= high:
            raise ValueError(f'Invalid layout {key}')

    for key in ('offsetX', 'offsetY', 'startAngle'):
        number(layout, key, -1e7, 1e7)
    if 'seed' in layout and not positive_id(layout['seed']):
        raise ValueError('Invalid layout seed')
    for name in ('userPrefs', 'overrides'):
        if name not in layout:
            continue
        prefs = layout[name]
        if not isinstance(prefs, dict):
            raise ValueError(f'Layout {name} must be an object')
        number(prefs, 'branchT', 0, 1)
        number(prefs, 'lengthScale', 0.001, 1000)
        number(prefs, 'curvatureScale', 0, 10)
        number(prefs, 'curvatureTightness', 0, 10)
        number(prefs, 'startAngle', -1e7, 1e7)
        number(prefs, 'angleOffset', -1e7, 1e7)
        if 'curvatureSign' in prefs and (type(prefs['curvatureSign']) is not int or prefs['curvatureSign'] not in (-1, 1)):
            raise ValueError('Invalid curvature direction')
        if 'curvatureDir' in prefs and prefs['curvatureDir'] not in ('cw', 'ccw'):
            raise ValueError('Invalid curvature direction')
        for key in ('userDrawn', 'allowOverlap', 'autoAdjust'):
            if key in prefs and type(prefs[key]) is not bool:
                raise ValueError(f'Invalid layout {key}')
    return layout
