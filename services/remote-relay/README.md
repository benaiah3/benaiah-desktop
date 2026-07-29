# Benaiah Remote Relay

This service lets a signed-in Benaiah mobile client control the user's own
Benaiah Desktop harness while that computer is online.

It is deliberately not a public SSH server:

- Desktop makes one outbound `wss://` connection.
- Mobile receives a separate, one-time client ticket for the same account and
  device.
- A Durable Object routes opaque JSON-RPC frames between the two connections.
- Tickets expire after 60 seconds and cannot be replayed.
- Devices can be revoked from the Benaiah account.
- The relay never opens an inbound port on the user's computer.

## Required production configuration

Set the same 32+ character `BENAIAH_REMOTE_RELAY_SECRET` in this Worker and the
Benaiah website. Set `BENAIAH_ALLOWED_ORIGINS` on the Worker (normally
`https://benaiah.ai`) and set the website's `BENAIAH_REMOTE_RELAY_URL` to the
custom `wss://` relay hostname.

The next integration layer is the Desktop host bridge. It obtains a host ticket,
connects here, and forwards each `relay.frame` to its loopback `/api/ws`
gateway. The mobile client obtains a client ticket and can reuse the existing
JSON-RPC gateway client unchanged.
