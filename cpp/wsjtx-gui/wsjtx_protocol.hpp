#pragma once

#include "types.hpp"

#include <QByteArray>
#include <optional>

// Parse one WSJT-X UDP datagram.  Returns a filled LogQSO on success, or
// std::nullopt if the packet isn't a LOG_QSO (wrong magic, wrong message
// type, or truncated).  Fields the server doesn't consume are dropped.
std::optional<LogQSO> parseLogQso(const QByteArray& data);
