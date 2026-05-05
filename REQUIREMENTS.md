# Requirements Specification: Ham Radio Contest Logging Application

## 1. Purpose

The application shall provide a modern contest logging system for amateur radio contests. It is intended for multiple operators working together under one shared contest callsign, such as a club station callsign. All operators shall be able to log QSOs into one shared logbook in real time.

The system shall support either:

- a server application that provides both the backend and a web-based user interface, or
- a server application with separate client applications connecting to it.

The preferred implementation language for both client and server is Go. A web-based interface served directly by the server is preferred if technically feasible.

## 2. General Architecture

### 2.1 Server

The server shall act as the central backend for the contest logbook. It shall store all logged QSOs and synchronize the log between all connected clients.

The server shall provide:

- central storage of all QSOs,
- user/session handling based on operator callsigns,
- real-time synchronization between all connected clients,
- a list of currently connected operators,
- configuration for the shared contest callsign under which all operators are working,
- an interface for clients or browsers to submit and retrieve log entries.

### 2.2 Client or Web Interface

Operators shall access the application either through:

- a dedicated client application, preferably written in Go, or
- a web browser using a web interface served by the server.

The preferred solution is a server-hosted web application, provided that transceiver integration through Hamlib or a suitable local helper component remains possible.

## 3. User and Station Concept

Each operator shall log in to the server using their own personal callsign.

However, all operators shall operate under one shared contest callsign, for example a club station callsign. This shared callsign shall be displayed clearly in the user interface.

Example:

- Logged-in operator: `DL1ABC`
- Shared contest callsign: `DK0XYZ`

The system shall make clear that the logged-in operator is entering QSOs on behalf of the shared contest station.

## 4. QSO Logging Requirements

The application shall allow operators to enter all relevant QSO details required for ham radio contest logging.

Each QSO entry shall support at least the following fields:

- callsign of the contacted station,
- date and time of the QSO,
- band,
- frequency / QRG,
- mode of operation,
- signal report sent,
- signal report received,
- RST report where applicable,
- Maidenhead locator,
- ITU zone,
- CQ zone,
- lighthouse number,
- operator callsign who logged the QSO,
- shared contest callsign,
- optional notes or remarks.

The date and time should preferably be filled automatically at the moment of logging, with the option to edit it if necessary.

## 5. Mode Handling

The application shall provide a dropdown list for selecting the mode of operation.

The mode list shall include common amateur radio modes, including at least:

- CW,
- SSB,
- USB,
- LSB,
- FM,
- AM,
- RTTY,
- FT8,
- FT4,
- PSK31,
- other digital modes where useful.

The application shall validate the signal report fields depending on the selected mode.

For CW, the signal report shall allow entering the full RST report, including the tone value `T`.

For voice modes such as SSB, FM, and AM, the application shall only require the RS report and shall not ask for or allow the tone value.

For digital modes, the application should allow appropriate reports depending on the contest or operating convention, for example numeric signal reports or dB reports where relevant.

## 6. Frequency / QRG Handling

The application shall allow manual entry of the QRG/frequency.

The application shall also support automatic reading of the currently selected transceiver frequency using Hamlib.

When Hamlib integration is active, the current QRG shall be read from the connected transceiver and inserted into the QSO entry automatically so the operator does not need to type it manually.

The application should also be able to derive the band from the current frequency where possible.

## 7. Hamlib / Transceiver Integration

The application shall make use of Hamlib to connect to a transceiver via USB or another supported interface.

The transceiver integration shall support at least:

- selecting the transceiver model,
- selecting the connection method or serial device,
- configuring baud rate and other connection parameters,
- reading the current frequency,
- optionally reading the current mode if supported by the transceiver and Hamlib,
- testing the connection from the settings screen.

If the application is implemented as a browser-based web app, a solution is required for local transceiver access. This may be implemented through:

- a small local helper service running on the client machine,
- a local Hamlib rigctld instance,
- or another secure local bridge between the browser and the transceiver.

The user interface shall clearly indicate whether transceiver connection is active, disconnected, or in an error state.

## 8. Settings

The application shall provide a separate settings tab or settings view.

The settings area shall include all relevant configuration options, including at least:

- server connection settings,
- operator callsign,
- shared contest callsign,
- contest name or identifier,
- transceiver model,
- Hamlib configuration,
- serial device or connection path,
- baud rate,
- polling interval for reading frequency,
- default mode,
- default band,
- user interface preferences where useful.

Settings shall be easy to understand and grouped logically.

## 9. Shared Logbook and Synchronization

The server shall maintain one shared contest logbook.

All connected clients shall write into the same shared log.

Every client shall be able to see all QSOs logged by all operators, not only the QSOs entered by the current operator.

When one operator logs a new QSO, the entry shall appear on all connected clients without requiring a manual refresh.

The application should prevent or warn about potential duplicate QSOs where possible.

The log shall show which operator entered each QSO.

## 10. Past QSO Display

The client or web interface shall contain a section showing past QSOs.

This QSO list shall include all QSOs from the shared logbook.

The QSO list should display at least:

- time,
- contacted callsign,
- frequency,
- band,
- mode,
- sent report,
- received report,
- locator,
- zone information where available,
- operator who logged the QSO.

The list should update live when new QSOs are added.

The list should be searchable and filterable where useful, for example by callsign, band, mode, or operator.

## 11. Connected Operators Display

The user interface shall include a panel on the right-hand side showing all operators currently logged in to the server.

Above the operator list, the application shall display the shared contest callsign under which all operators are operating.

Example layout:

```text
Operating as: DK0XYZ

Connected operators:
- DL1ABC
- DO2XYZ
- DL3DEF
```

The connected operator list shall update automatically when operators connect or disconnect.

## 12. User Interface Requirements

The application shall have a modern, aesthetically pleasing interface.

The preferred visual style is:

- dark Material Design look,
- light blue accent color,
- clean spacing,
- high readability,
- clear separation between logging form, QSO history, settings, and connected operators.

The main logging screen should preferably contain:

- a central QSO entry form,
- a past-QSO table or log view,
- a right-hand panel with connected operators,
- clear indication of the shared contest callsign,
- clear indication of transceiver/Hamlib connection status.

The interface shall be suitable for fast contest operation, meaning that data entry should require as few clicks as possible.

Keyboard-focused operation is desirable. Operators should be able to move quickly through fields and submit a QSO efficiently.

## 13. Data Validation

The application shall validate entered QSO data before saving.

Validation shall include at least:

- callsign format checks,
- required fields depending on contest configuration,
- valid frequency format,
- valid mode selection,
- appropriate signal report format depending on mode,
- valid Maidenhead locator format where entered,
- valid ITU zone and CQ zone values where entered.

Validation errors shall be shown clearly and should not destroy already entered data.

## 14. Storage and Export

The server shall store the log persistently so that QSOs are not lost when the server restarts.

The application should support exporting the log in common amateur radio formats, especially:

- ADIF,
- Cabrillo, if contest submission support is desired,
- CSV for general analysis or backup.

Import support for existing logs may be considered as an optional feature.

## 15. Reliability and Multi-Client Behavior

The application shall be designed for reliable multi-client operation during contests.

The system shall handle:

- multiple clients connected at the same time,
- simultaneous QSO submissions,
- reconnecting clients,
- temporary network interruptions,
- server restart without data loss.

The application should avoid duplicate entries caused by repeated submissions or network retries.

## 16. Security and Access Control

The server shall require operators to log in with their callsign.

Depending on the deployment scenario, the system should optionally support authentication beyond callsign entry, for example passwords or local network trust.

The server should provide basic protection against unauthorized log manipulation.

Administrative settings, such as the shared contest callsign and contest configuration, should be protected from accidental or unauthorized changes.

## 17. Preferred Technology Stack

The preferred programming language is Go.

Preferred implementation options:

1. Go server serving a web interface and backend API.
2. Go server plus separate Go-based desktop client.
3. Go server plus web interface plus optional local helper service for Hamlib access.

The preferred architecture is a single server application that serves the web interface, provided that transceiver integration can be implemented cleanly and reliably.

## 18. Possible Technical Challenge: Browser-Based Hamlib Access

A pure browser-based application cannot normally access a USB-connected transceiver directly without additional support.

Therefore, if the user interface is browser-based, the application may require one of the following:

- a local helper application on each operator computer,
- a locally running Hamlib `rigctld` service,
- a desktop wrapper application,
- or a browser-compatible local bridge.

This requirement shall be considered during architecture design.

## 19. Non-Functional Requirements

The application shall be:

- fast enough for real contest operation,
- stable over long operating periods,
- easy to use under time pressure,
- readable in dark environments,
- robust against accidental data loss,
- understandable for radio operators who are not software experts.

## 20. Summary

The desired application is a centralized ham radio contest logger. Multiple operators log in with their own callsigns but operate under one shared contest callsign. All QSOs are stored in one shared logbook on the server and synchronized live between all clients.

The application shall provide fast QSO entry, mode-aware signal report handling, Hamlib-based transceiver integration for automatic frequency reading, a settings area, a live QSO history, and a connected-operator list. The preferred implementation is a Go-based server that serves a modern dark Material Design web interface with light blue accents.
