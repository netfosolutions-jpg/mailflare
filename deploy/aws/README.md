# Mailflare on AWS (EC2, S3, SES)

One EC2 instance runs Mailflare and Caddy in Docker. S3 holds blobs, SES sends
outbound mail, and the built-in SMTP listener receives inbound mail for
carsens.co and netfo.co. Follow the steps in order. Replace `BUCKET_NAME` and
`REGION` (for example `eu-west-1`) throughout. Run steps 1 to 5 from this
directory on a machine with the AWS CLI configured.

## 1. Create the S3 bucket

Private, with all public access blocked, plus the lifecycle rule that aborts
incomplete multipart uploads after 7 days.

```bash
aws s3api create-bucket --bucket BUCKET_NAME --region REGION \
  --create-bucket-configuration LocationConstraint=REGION
aws s3api put-public-access-block --bucket BUCKET_NAME \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-lifecycle-configuration --bucket BUCKET_NAME \
  --lifecycle-configuration file://s3-lifecycle.json
```

In `us-east-1`, omit `--create-bucket-configuration`.

## 2. Create the IAM user for the app

```bash
sed 's/BUCKET_NAME/your-bucket-name/g' iam-policy.json > iam-policy.local.json
aws iam create-user --user-name mailflare-app
aws iam put-user-policy --user-name mailflare-app --policy-name mailflare \
  --policy-document file://iam-policy.local.json
aws iam create-access-key --user-name mailflare-app
```

Keep the `AccessKeyId` and `SecretAccessKey`. They go in `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY`.

## 3. Verify both domains in SES

In the SES console for `REGION`, create an identity for `carsens.co` and one for
`netfo.co`, with Easy DKIM. SES shows three DKIM tokens per domain. Add them as
the CNAME records from [DNS-RECORDS.md](DNS-RECORDS.md) (step 7). Each identity
turns Verified once DNS propagates.

## 4. Create the SES SMTP credentials

Create a second IAM user restricted to `ses:SendRawEmail`, and generate SMTP
credentials for it (SES console, SMTP settings, Create SMTP credentials, which
creates that user). SES SMTP credentials are not the same as the access keys
from step 2: the SMTP password is derived from the secret key. Put them in
`SMTP_URL`:

```
smtps://SES_SMTP_USER:SES_SMTP_PASSWORD@email-smtp.REGION.amazonaws.com:465
```

URL-encode any special characters in the password.

## 5. Request SES production access

SES console, Account dashboard, Request production access. Do this before
go-live: in the sandbox SES only delivers to verified addresses.

## 6. Launch EC2

- Ubuntu 24.04, 2 vCPU and 8 GB (for example `t3.large`), 30 GB gp3 volume.
- Security group inbound: 22 from your IP only; 25, 80 and 443 from anywhere.
- Allocate an Elastic IP and associate it with the instance.

## 7. Set the DNS records

Create every record in [DNS-RECORDS.md](DNS-RECORDS.md) for both domains.

## 8. Bootstrap the server

SSH in as `ubuntu`, fetch `bootstrap.sh` from your fork, then:

```bash
FORK_URL=https://github.com/YOU/mailflare.git sudo -E bash bootstrap.sh
# the first run creates /opt/mailflare/deploy/aws/.env.aws and stops
sudo nano /opt/mailflare/deploy/aws/.env.aws
FORK_URL=https://github.com/YOU/mailflare.git sudo -E bash bootstrap.sh
```

The second run builds the image and starts Mailflare and Caddy. Caddy obtains
the certificate for `mail.netfo.co` automatically once DNS resolves.

## 9. Set up Mailflare

1. Open `https://mail.netfo.co/setup` and create the admin account.
2. Admin > Domains: add `carsens.co` and `netfo.co`.
3. Admin > General: set the storage limit to `1000` (GB).

carsens.co users sign in at `https://mail.netfo.co`.

## 10. Test mail flow

Send from a mailbox to an outside address, then from an outside address back in.
If either fails, check:

- Port 25 is open in the security group (and not blocked by the sender's network).
- Both domains' MX is `10 mail.netfo.co`, and `mail.netfo.co` points at the Elastic IP.
- SES is out of the sandbox and both identities are Verified.
- The logs:

```bash
cd /opt/mailflare/deploy/aws
docker compose -f docker-compose.aws.yml logs --tail=200 mailflare caddy
```

## 11. EBS snapshot schedule

Mailflare's daily backup (02:00 UTC) writes to the bucket. The SQLite file on
the instance volume is covered by an EBS snapshot policy: EC2 console,
Lifecycle Manager, Create lifecycle policy, EBS snapshot policy. Target volumes
by tag, schedule daily, retain 14 snapshots. Tag the instance's volume:

```bash
aws ec2 create-tags --resources VOLUME_ID --tags Key=backup,Value=mailflare
```
