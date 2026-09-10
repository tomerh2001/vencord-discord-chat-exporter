/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";

import type { ExportOptions } from "./options";

export const settings = definePluginSettings({}).withPrivateSettings<{ exportOptions?: ExportOptions; }>();
