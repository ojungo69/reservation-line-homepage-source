# Preserved behavior

Echo: all existing identity predicates plus non-null exact etag and time-value expiry greater than now. Equality/malformed/null is not live.

Settings: privileged response retains staff data; staff response may omit it without type/consumer error. Real UI zero post-buffer succeeds; server still rejects nonzero. Existing auth/transport/error contracts stay.
