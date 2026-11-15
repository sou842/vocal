"""Video styles. Importing this package registers every style module found in video/styles/."""
import importlib
import pkgutil

from . import styles as _styles
from .core import STYLES, list_styles, make_video, preview_path  # noqa: F401

for _m in pkgutil.iter_modules(_styles.__path__):
    importlib.import_module(f"{__name__}.styles.{_m.name}")
