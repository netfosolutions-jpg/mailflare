# DNS records

Replace `ELASTIC_IP` with the instance's Elastic IP and `DKIM_TOKEN_1` to
`DKIM_TOKEN_3` with the three tokens SES shows for each domain (each domain has
its own tokens). Both domains receive mail at `mail.carsens.co`.

## carsens.co

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `mail.carsens.co` | `ELASTIC_IP` | 300 |
| MX | `carsens.co` | `10 mail.carsens.co` | 300 |
| TXT | `carsens.co` | `"v=spf1 include:amazonses.com -all"` | 300 |
| CNAME | `DKIM_TOKEN_1._domainkey.carsens.co` | `DKIM_TOKEN_1.dkim.amazonses.com` | 300 |
| CNAME | `DKIM_TOKEN_2._domainkey.carsens.co` | `DKIM_TOKEN_2.dkim.amazonses.com` | 300 |
| CNAME | `DKIM_TOKEN_3._domainkey.carsens.co` | `DKIM_TOKEN_3.dkim.amazonses.com` | 300 |
| TXT | `_dmarc.carsens.co` | `"v=DMARC1; p=quarantine; rua=mailto:dmarc@carsens.co"` | 300 |

## netfo.co

| Type | Name | Value | TTL |
|---|---|---|---|
| MX | `netfo.co` | `10 mail.carsens.co` | 300 |
| TXT | `netfo.co` | `"v=spf1 include:amazonses.com -all"` | 300 |
| CNAME | `DKIM_TOKEN_1._domainkey.netfo.co` | `DKIM_TOKEN_1.dkim.amazonses.com` | 300 |
| CNAME | `DKIM_TOKEN_2._domainkey.netfo.co` | `DKIM_TOKEN_2.dkim.amazonses.com` | 300 |
| CNAME | `DKIM_TOKEN_3._domainkey.netfo.co` | `DKIM_TOKEN_3.dkim.amazonses.com` | 300 |
| TXT | `_dmarc.netfo.co` | `"v=DMARC1; p=quarantine; rua=mailto:dmarc@netfo.co"` | 300 |

Notes:

- netfo.co's MX also points at `mail.carsens.co`, so it needs no `A` record for
  mail. Add `A mail.netfo.co` to `ELASTIC_IP` only if you want `mail.netfo.co`
  as an alias (Caddy would then also need that site name).
- Without `CF_TOKEN`, Mailflare records each zone as manually managed and lists
  the records to set; this file is the same set.
- Create `dmarc@<domain>` as a mailbox or alias so DMARC reports arrive.
