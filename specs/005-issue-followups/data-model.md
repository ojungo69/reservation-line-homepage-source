# Existing entities

outbound_writes retains current identity/etag/action fields and expiry. No column/history mutation. Eligibility is identity match plus strictly future parseable expiry.

Settings snapshot retains services/resources and role-dependent staff. Staff omission is intentional. Service creation retains the reserved zero post-buffer.
