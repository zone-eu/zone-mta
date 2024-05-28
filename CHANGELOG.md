# Changelog

## [3.9.7](https://github.com/zone-eu/zone-mta/compare/v3.9.6...v3.9.7) (2024-05-28)


### Bug Fixes

* **tls:** sender.js will on a tls failure try a delivery with out tls. However on freebsd 13 a misconfigured server may show ([#393](https://github.com/zone-eu/zone-mta/issues/393)) ([530b495](https://github.com/zone-eu/zone-mta/commit/530b495959fdcd2f5585738ddf6e01492754cfa9))

## [3.9.6](https://github.com/zone-eu/zone-mta/compare/v3.9.5...v3.9.6) (2024-05-13)


### Bug Fixes

* **deps:** Bumped deps to clear out some security warnings ([3849037](https://github.com/zone-eu/zone-mta/commit/3849037ba0a6a680c4b9a3d2e4bd371c58bc33aa))

## [3.9.5](https://github.com/zone-eu/zone-mta/compare/v3.9.4...v3.9.5) (2024-03-27)


### Bug Fixes

* **api:** Added query argument `includeDisabled` to /zones API endpoint. If `true` returns all zones ([fb826d6](https://github.com/zone-eu/zone-mta/commit/fb826d6de294f23387b1fb4ef90ad20889779113))

## [3.9.4](https://github.com/zone-eu/zone-mta/compare/v3.9.3...v3.9.4) (2024-02-09)


### Bug Fixes

* **logs:** send bounce information to remote log ([3fd3986](https://github.com/zone-eu/zone-mta/commit/3fd3986b3874071e135060fca7695a23715c4ff1))

## [3.9.3](https://github.com/zone-eu/zone-mta/compare/v3.9.2...v3.9.3) (2024-02-08)


### Bug Fixes

* **bounces:** fixed bounce handling in mail queue ([05d2b8d](https://github.com/zone-eu/zone-mta/commit/05d2b8d6ec21d4c280b5da7e7e1dd1053354f49d))
* **sts:** do not try to store error object as JSON value ([9a45336](https://github.com/zone-eu/zone-mta/commit/9a45336a2bc92247c95880abf1aa0df42b682b2a))

## [3.9.2](https://github.com/zone-eu/zone-mta/compare/v3.9.1...v3.9.2) (2024-02-08)


### Bug Fixes

* **deps:** bumped nodemailer and smtp-server versions ([0a2371d](https://github.com/zone-eu/zone-mta/commit/0a2371dbc4dc5874ebea04b8ce3568030039d853))
* **logs:** added new remote log entry QUEUE_POLL ([800b583](https://github.com/zone-eu/zone-mta/commit/800b5835e99a7f1e0370b114b2821464785ac30a))

## [3.9.1](https://github.com/zone-eu/zone-mta/compare/v3.9.0...v3.9.1) (2024-02-02)


### Bug Fixes

* **api:** added endpoint to list locked domains ([25102ca](https://github.com/zone-eu/zone-mta/commit/25102ca71010951fb592c6d8bdb4852976a49c1e))
* **loop:** reject messages with too many Received headers ([cbffa6d](https://github.com/zone-eu/zone-mta/commit/cbffa6d3dcadb937b9303a42fbe2603fd1668fb8))
* **mime-head:** Increased allowd MIME node header size to 2MB ([26e4896](https://github.com/zone-eu/zone-mta/commit/26e48967bd96e8aa08b1986513fe4733961bd672))
* **tls-options:** Retrieve ignoreTLS value from Sending Zone, or default to false ([#365](https://github.com/zone-eu/zone-mta/issues/365)) ([336e835](https://github.com/zone-eu/zone-mta/commit/336e8358be5992bd15392fc07064540fda4aa23d))

## [3.9.0](https://github.com/zone-eu/zone-mta/compare/v3.8.0...v3.9.0) (2024-01-19)


### Features

* **bounces:** Send a delayed notification email if a delivery has not been completed after 3 hours ZMS-56 ([#363](https://github.com/zone-eu/zone-mta/issues/363)) ([a535e3a](https://github.com/zone-eu/zone-mta/commit/a535e3a7e10e517eaac13af6819420aa45d10725))

## [3.8.0](https://github.com/zone-eu/zone-mta/compare/v3.7.0...v3.8.0) (2024-01-15)


### Features

* **api:** Allow ordering queue listing ([41017ff](https://github.com/zone-eu/zone-mta/commit/41017ffa3cdc852e0ea4960ec45ea94092aa7699))

## [3.7.0](https://github.com/zone-eu/zone-mta/compare/v3.6.13...v3.7.0) (2023-12-14)


### Features

* **plugins:** Added new plugin hook sender:responseError, allow configuratble defer times ([#360](https://github.com/zone-eu/zone-mta/issues/360)) ([061248f](https://github.com/zone-eu/zone-mta/commit/061248f647a98a74f33fa0da09ea2a13e42be6ac))


### Bug Fixes

* **bounce:** Fixed Outlook no-such-user bounce detection ([#357](https://github.com/zone-eu/zone-mta/issues/357)) ([0b49571](https://github.com/zone-eu/zone-mta/commit/0b49571fb6677a1570ec1b266cecb81aa5e567e5))

## [3.6.13](https://github.com/zone-eu/zone-mta/compare/v3.6.12...v3.6.13) (2023-10-12)


### Bug Fixes

* **deploy:** updated package-lock to fix release ([4248526](https://github.com/zone-eu/zone-mta/commit/42485265748bef6cbcf34eb570fdfae422128abb))

## [3.6.12](https://github.com/zone-eu/zone-mta/compare/v3.6.11...v3.6.12) (2023-10-12)


### Bug Fixes

* **queue:** mark emails with 'mailbox full' responses as rejected, not deferred ([c2040e2](https://github.com/zone-eu/zone-mta/commit/c2040e284e337e79c6987b3cf393c669d08a04c8))
* **queue:** replaced non-likely bounces from deferred to rejected ([c701efd](https://github.com/zone-eu/zone-mta/commit/c701efde4907ea969aef92e7dbfc517a993d8ce9))

## [3.6.11](https://github.com/zone-eu/zone-mta/compare/v3.6.10...v3.6.11) (2023-10-05)


### Bug Fixes

* **mail2http:** retry 5xx responses ([33aa6d5](https://github.com/zone-eu/zone-mta/commit/33aa6d5b3c726206563649137de2b42e9bb38bd7))

## [3.6.10](https://github.com/zone-eu/zone-mta/compare/v3.6.9...v3.6.10) (2023-09-29)


### Bug Fixes

* **bounces:** Fixed MS365 missing user bounce check regex ([3e0853a](https://github.com/zone-eu/zone-mta/commit/3e0853aef154bdfcdaf7d879017559991e03b507))

## [3.6.9](https://github.com/zone-eu/zone-mta/compare/v3.6.8...v3.6.9) (2023-09-18)


### Bug Fixes

* **deploy:** Added repository URL for automatic publishing ([6172534](https://github.com/zone-eu/zone-mta/commit/6172534567299e0c9c568446c6b62e87949e9272))

## [3.6.8](https://github.com/zone-eu/zone-mta/compare/v3.6.7...v3.6.8) (2023-09-18)


### Bug Fixes

* **readme:** Updated readme to trigger package publish ([b90d31b](https://github.com/zone-eu/zone-mta/commit/b90d31b610862bf1c9db9c4df41af1a41a905866))

## [3.4.1](https://github.com/zone-eu/zone-mta/compare/v3.4.0...v3.4.1) (2023-09-18)


### Bug Fixes

* **deploy:** Set up auto publishing to NPM ([#338](https://github.com/zone-eu/zone-mta/issues/338)) ([b1d6fef](https://github.com/zone-eu/zone-mta/commit/b1d6fef8931a4e40042694414318d1dd5fda2914))
* **tests:** Added Github action to run tests ([#341](https://github.com/zone-eu/zone-mta/issues/341)) ([908edf9](https://github.com/zone-eu/zone-mta/commit/908edf9321be5342426127d081997bde116ff23b))

## CHANGELOG

-   v3.6.6 2023-05-24

    -   Bumped mx-connect for MTA-STS caching fix

-   v3.6.3 2023-02-08

    -   Do not stop mail processing if MTA-STS policy loading failed

-   v3.6.0 2023-02-02

    -   Added support for MTA-STS. Enabled by default.

-   v3.5.0 2022-12-04

    -   Bumped Restify to v10 to support Node 18
    -   Added new plugin hook `smtp:init`

-   v3.3.0 2022-02-23

    -   Bumped deps (fixes issue with 334 response)
    -   Replaced deprecated cursor.count() calls with collection.countDocuments()

-   v3.2.4 2021-10-01

    -   Extra logging options for HTTP message uploads

-   v3.2.3 2021-09-23

    -   Fix broken mongodb collection.find()

-   v3.2.0 2021-09-05

    -   Update mongodb library from v3 to v4
    -   Fix connection pooling with IPv6 (jpbede)

-   v3.1.0 2021-06-01

    -   Bumped dependencies

-   v3.0.0 2021-05-14

    -   Added new plugin hook 'smtp:sni' for custom secure context
    -   Allow using promise based plugins instead of callbacks
    -   Allow calling plugin hooks without ZoneMTA daemon running (allows to reuse ZoneMTA plugins in external applications)
    -   Requires at least Node v10

-   v2.4.3 2021-03-04

    -   Prom Client uses promises, so had to fix compatibility for the API server

-   v2.4.1 2021-02-01

    -   another attempt to fix error message for too large emails

-   v2.4.0 2021-02-01

    -   Handle suppression entries case-insensitive (teefax)
    -   Add messageId to the entry object when using remote log (ohmysmtp)
    -   do not wait longer than 500ms for DNS redis cache response
    -   fix error message for too large emails

-   v2.3.3 2020-10-06

    -   Minor changes in blacklist rules

-   v2.3.2 2020-10-05

    -   Do not categorize response codes like 550 automaticaly as "recipient"

-   v2.3.1 2020-09-24

    -   Updates in bounce messages

-   v2.3.0 2020-06-25

    -   Added new hook 'sender:connection' that is run for every message, even when using cached connections

-   v2.2.0 2020-05-27

    -   Updated garbage collection to delete orphaned message chunks by \_id
    -   Added new option queue.maxQueueTime (default 30 days) to delete unprocessed entries from queue

-   v2.1.0 2020-05-27

    -   Added bunch of new bounce responses
    -   There is now a connection pool (since 2.0.0)

-   v1.17.0 2019-06-14

    -   Fixed O365 bounce msg. (jpbede)
    -   Make plugin api doc clear (jpbede)
    -   Plugin HTTP API (jpbede)
    -   DKIM: Configurable headers to sign (jpbede)
    -   Make default zone configurable (jpbede)
    -   Added new hook "smtp:connect" (jpbede)
    -   added new outlook blacklist response
    -   Add gmail block and odd greylist bounces (louis-lau)

-   v1.16.3 2019-06-14

    -   Do not cache failed STARTTLS info, always try encryption first

-   v1.16.1 2019-06-10

    -   Bumped dependencies to get rid of security warnings
    -   Some new blacklist filters

-   v1.16.0 2019-04-04

    -   Added new hook "sender:delivered"

-   v1.15.6 2019-03-21

    -   Reverted Restify from 8 to 7 as 8 does not support Node v6
    -   Convert line endings for incoming messages to always use 0x0D 0x0A, otherwise DKIM might get messed up

-   v1.15.5 2019-03-18

    -   Added new headers to DKIM list

-   v1.15.4 2019-02-20

    -   Fixed a typo in blacklist detection patterns

-   v1.15.0 2019-01-24

    -   Fixed broken TLS support on connection

-   v1.14.0 2019-01-04

    -   Fixed useProxy setting

-   v1.13.0 2018-10-23

    -   Added option for plugins to send messages to Graylog

-   v1.12.1 2018-10-19

    -   Log connection errors to MX servers

-   v1.12.0 2018-09-24

    -   Allow overrideing database entry keys for deferred messages using `delivery.updates = {keys}`

-   v1.11.0 2018-09-14

    -   Allow disabled bounce emails for messages from specific interfaces

-   v1.10.8 2018-09-12

    -   Fixed issue with missing CA certs

-   v1.10.4 2018-08-22

    -   Fixed an issue with MX connection timeouts where a working MX exisits but never was tried

-   v1.10.2 2018-08-16

    -   Fixed broken relay

-   v1.10.0 2018-07-30

    -   Bumped dependencies. Upgraded MongoDB driver to 3.1.

-   v1.8.4 2018-05-25

    -   Fixed `host` option for zones

-   v1.8.1 2018-05-22

    -   Use delivery object for the connect hook argument

-   v1.8.0 2018-05-17

    -   Offload TCP connections for MX to mx-connect module

-   v1.7.3 2018-04-28

    -   Fixed race condition with Redis on large number of sending zone processes

-   v1.7.0 2018-04-17

    -   Allow using SMTP [server options](https://nodemailer.com/extras/smtp-server/#step-3-create-smtpserver-instance) for SMTP interfaces

-   v1.6.0 2018-02-08

    -   Changed index handling. Indexes are defined in indexes.yaml instead of being hard coded to mail-queue.js
    -   Do not search using \$ne, instead a separate index was added

---

-   v1.0.0-beta.25 2017-03-13

    -   Drop LevelDB support entirely, use MongoDB for all storage related stuff

-   v1.0.0-beta.16 2017-01-30

    -   Start using MongoDB GridFS for message storage instead of storing messages in LevelDB. This is an external requirement, MongoDB does not come bundled with ZoneMTA

-   v1.0.0-beta.3 2017-01-02

    -   Log message data to UDP

-   v1.0.0-beta.2 2016-12-23

    -   Do not store deleted messages, remove everything in the first possible moment

-   v0.1.0-alpha.8 2016-10-05

    -   Added cli command "zone-mta" to create and run ZoneMTA applications
    -   Added API endpoint to check message status in queue
    -   Added new plugin option (`app.addStreamHook`) to process attachment streams without modifying the message. This can be used to store attachments to disk or calculating hashes etc. on the fly

-   v0.1.0-alpha.5 2016-09-25

    -   Allow multiple SMTP interfaces (one for 465, one for 587 etc)

-   v0.1.0-alpha.4 2016-09-21

    -   Added option to log to syslog instead of stderr

-   v0.1.0-alpha.3 2016-09-21

    -   Added plugin system to be able to easily extend ZoneMTA
    -   Added plugin to use Rspamd for message scanning
    -   Added plugin to send bounce notifications either to an URL or email address or both
    -   Converted built-in HTTP calls to optional plugins (authentication, sender config etc)
    -   Allow total or partial message rewriting through the rewrite API

-   v0.1.0-alpha.2 2016-09-06

    -   Added option to forward messages of a Zone not to MX but to another predefined MTA

-   v0.1.0-alpha.1 2016-09-06
    -   Initial release
