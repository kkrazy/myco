# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The solver substrates behind one interface (substrate/base.py).

`OpencodeSubstrate` carries OPENCODE_SURFACE and three install modes; `CodexSubstrate`
carries CODEX_SURFACE and one. Benchmark adapters supply the launcher body for both.

`MycoSubstrate` carries MYCO_SURFACE and one install mode (`myco_workspace`); it needs
no launcher because its runner CLI is a frozen contract rather than a benchmark choice.
"""

from .base import Install, Launcher, RunRequest, Substrate
from .codex import CODEX_SURFACE, CodexSubstrate
from .myco import MYCO_SURFACE, MycoSubstrate
from .opencode import OPENCODE_SURFACE, OpencodeSubstrate

__all__ = [
    "Install",
    "Launcher",
    "RunRequest",
    "Substrate",
    "OpencodeSubstrate",
    "OPENCODE_SURFACE",
    "CodexSubstrate",
    "CODEX_SURFACE",
    "MycoSubstrate",
    "MYCO_SURFACE",
]
