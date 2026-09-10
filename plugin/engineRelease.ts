/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Official GitHub release asset digests, pinned rather than accepted from the download response.
// https://github.com/Tyrrrz/DiscordChatExporter/releases/tag/2.48
export const ENGINE_VERSION = "2.48";
export const ENGINE_RELEASE = {
    "version": "2.48",
    "assets": [
        {
            "rid": "linux-arm",
            "fileName": "DiscordChatExporter.Cli.linux-arm.zip",
            "sha256": "48969a30c6e3a160477d0eae09885c66369782f6bf8997e596707295333bfc69",
            "archiveBytes": 9215196
        },
        {
            "rid": "linux-arm64",
            "fileName": "DiscordChatExporter.Cli.linux-arm64.zip",
            "sha256": "02a47fc8e0192fd509fbb082aadd9322035b18feae96849699fefc424a1e3379",
            "archiveBytes": 11315475
        },
        {
            "rid": "linux-musl-x64",
            "fileName": "DiscordChatExporter.Cli.linux-musl-x64.zip",
            "sha256": "ba927a31dfb36325010996b62e9ff979b3c64efd7199ab466e02a532d40cde5b",
            "archiveBytes": 11986773
        },
        {
            "rid": "linux-x64",
            "fileName": "DiscordChatExporter.Cli.linux-x64.zip",
            "sha256": "3e253e28ec7ea034b2201443fa84571142945299296541ecbe196ffceef8bc3c",
            "archiveBytes": 11984338
        },
        {
            "rid": "osx-arm64",
            "fileName": "DiscordChatExporter.Cli.osx-arm64.zip",
            "sha256": "623f9d2dce568e17a46b8fbd366a18dca49803d386216f4ba24507d2c000fee9",
            "archiveBytes": 10417274
        },
        {
            "rid": "osx-x64",
            "fileName": "DiscordChatExporter.Cli.osx-x64.zip",
            "sha256": "91b4eae3525df85d084969004f3a287edad4eeaafd664e4869b26bb8422e2e88",
            "archiveBytes": 11204861
        },
        {
            "rid": "win-arm64",
            "fileName": "DiscordChatExporter.Cli.win-arm64.zip",
            "sha256": "0be2deec0163c8fe44889c0f6e6b7d5ac4d02a97713a685f86c10bdffc8deed2",
            "archiveBytes": 11125281
        },
        {
            "rid": "win-x64",
            "fileName": "DiscordChatExporter.Cli.win-x64.zip",
            "sha256": "9f6706f6311f1387bc29d536e951d6c758716a57f59a2f2ce1718616ea6574b1",
            "archiveBytes": 11448499
        },
        {
            "rid": "win-x86",
            "fileName": "DiscordChatExporter.Cli.win-x86.zip",
            "sha256": "5ba5a23c4762b35522e54023a2094d88760f137631a415fc8aa2e1cf76c8e510",
            "archiveBytes": 10068245
        }
    ]
} as const;
