# Releases

Every over-the-air update published to the `production` channel, newest first. Each row gives the
public commit the update was built from and the SHA-256 of the JavaScript bundle each platform runs.

| Published | Runtime | Update group | Commit | iOS bundle SHA-256 | Android bundle SHA-256 |
|---|---|---|---|---|---|
| 2026-11-27 07:54 UTC | 1.3.8 | `620baf0f-486f-4d41-9f9d-a5846297c058` | `f3b6dd90cba551d6e10332eda7556e57fdaa3723` | `cdf780cdf799d1422d866c239672e93c80f675c354b21db6f7550c7b203f80fb` | `470115c13c126ba46ab93080f61d3d834f6234d4d02680e2c479587c68d840f7` |
| 2026-11-27 07:51 UTC | 1.3.9 | `a2840d72-8bea-4708-9e6d-1ac3f026266a` | `f3b6dd90cba551d6e10332eda7556e57fdaa3723` | `5dc2a5b7a17ff5869451d885d87e4371ed0f4aa965193a6ab2850ab3063c8930` | `f742ca2df07f8eae9cd88004c5fc71faa0a48c114976a172794e98e8f0b18a4d` |
| 2026-11-20 21:06 UTC | 1.3.8 | `4db82341-5188-4eb5-ab97-9db88978abd1` | `a0aac7de6edb5f867e339cb55f9d4b2f5c36778a` | `6fa27cc7799422d93bd3f2532a203e89eee21a0c8a7ff8e392a293999bb35186` | `8005d66c5c0ec406d4e59ef183f4d31316f2a409456f43d7b02703b24a8976b1` |
| 2026-11-20 16:21 UTC | 1.3.8 | `1c56e63d-725c-44fa-beb2-24d88a310c22` | `b1c0866a4aeb2b61b3de5704aad20ccd54b18b51` | `cc3c82a227dc20123ee26dfac5178b3fca21cbb02cd7a3bb5aef12fa48890e06` | `af37c53aa44615bc61edd0639d6081c62c1a87244d1b445d9347ca609fc8b8bc` |
| 2026-11-19 22:25 UTC | 1.3.8 | `e9e61af3-6e1b-498c-a1e9-977462e77de8` | `a0aac7de6edb5f867e339cb55f9d4b2f5c36778a` | `6fa27cc7799422d93bd3f2532a203e89eee21a0c8a7ff8e392a293999bb35186` | `8005d66c5c0ec406d4e59ef183f4d31316f2a409456f43d7b02703b24a8976b1` |
| 2026-11-17 12:08 UTC | 1.3.8 | `6dcf7e89-6716-48b1-b98e-286636da9905` | `9f2c42abefc1da3727037621a5dd88a84714588f` | `b01c64f344d2b9dbd6554a37bd72a06ee473e596ae21de8cc6fb6d1686e35d49` | `cf27074a89db8ea1808b9654d000c72958121ab435dda7bf36d4ef1630b2ba27` |
| 2026-11-16 16:35 UTC | 1.3.8 | `61445b4b-9712-44f9-8427-236c8eae73d9` | `a70cae08a227174f2a515694962eb62a25e6a4cf` | `3e23a517b9e7f45e2180617a68c303dfea87b5ed964af3fd2671a8f229bdcdc4` | `9fe440cc9e42724ddce1b52fc533c85917d99d42f906a9b4decdfe23e38be5c9` |
| 2026-11-16 14:06 UTC | 1.3.8 | `81afaf29-dc10-4ccf-a9c2-ea5ed560a4dd` | `a07c60f3697192c72d2f19f652ecd8658a3e6bec` | `e1c47207333ab2030a340cd35cee634eca7169f5ded8651030d6b2ce3ff8a392` | `de6e71bdac9767149dc407f9971502559fd21e4d2272f39b3a98aaa6d0957124` |

The two 2026-11-27 rows are one commit published to both runtimes. The 1.3.8 one was built with the
app version set to 1.3.8 for that build only, so its bundles differ from the 1.3.9 ones. The
2026-11-20 21:06 row is a republish of the 2026-11-19 update, so it has the same bundles. The
2026-11-20 16:21 update was rolled back the same day. Updates older than 2026-11-16 are not listed.

## What this proves and what it does not

The hash ties each update to exactly what Mera published to Expo's update service, and the commit
says which public source it was built from. The build is not reproducible, so the hash cannot prove
that the bundle was built from that commit: you can check that your phone runs what Mera published,
not that what Mera published matches the source.

## How to check a row

Each platform's update has its own id (`eas update:view <group>` lists them). Expo's update service
serves its manifest:

```sh
curl -s -H "expo-platform: ios" -H "expo-protocol-version: 1" -H "accept: multipart/mixed" \
  https://u.expo.dev/update/<update id>
```

The manifest's `launchAsset.hash` is the base64url SHA-256 of the bundle. Decode it to hex and
compare it with the table:

```sh
echo '<launchAsset.hash>=' | tr '_-' '/+' | base64 -d 2>/dev/null | xxd -p -c 32
```

Keep the `=` after the hash: without it `base64` drops the last bytes and the hex comes out short. The bundle file itself is served only
to the update client, so a plain download of `launchAsset.url` is refused.
