# GCP Deployment Instructions for Opto Layer

To deploy this SaaS to your Google Cloud project, you do not need to give me direct access. You can deploy it yourself in about 10 minutes using the Google Cloud CLI (`gcloud`).

## Prerequisites
1. Ensure you have the `gcloud` CLI installed and authenticated (`gcloud auth login`).
2. Ensure you have a Google Cloud Project created and billing enabled.

## Step 1: Set Project and Enable APIs
```bash
# Set your active project
gcloud config set project YOUR_PROJECT_ID

# Enable required APIs
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  cloudbuild.googleapis.com
```

## Step 2: Create Cloud Storage Bucket (For Images)
```bash
# Create a multi-region bucket for fast image read/writes
gsutil mb -l US gs://opto-multimodal-blobs-YOUR_PROJECT_ID
```

## Step 3: Create Cloud SQL (PostgreSQL) Database
```bash
# Create the PostgreSQL instance (Micro tier for starting out)
gcloud sql instances create opto-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1

# Create the specific database inside the instance
gcloud sql databases create optodb --instance=opto-db

# Set the password for the default 'postgres' user
gcloud sql users set-password postgres \
  --instance=opto-db \
  --password=YOUR_SECURE_PASSWORD
```

## Step 4: Deploy to Cloud Run
Run the deployment command directly from the `/home/venu/proxy_layer` directory.

```bash
gcloud run deploy opto-proxy \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --add-cloudsql-instances YOUR_PROJECT_ID:us-central1:opto-db \
  --set-env-vars="NODE_ENV=production,GCS_BUCKET_NAME=opto-multimodal-blobs-YOUR_PROJECT_ID,DB_USER=postgres,DB_PASSWORD=YOUR_SECURE_PASSWORD,DB_NAME=optodb,DB_HOST=/cloudsql/YOUR_PROJECT_ID:us-central1:opto-db"
```

## Step 5: Test the SaaS!
Once deployed, Cloud Run will output a URL (e.g., `https://opto-proxy-abc123.a.run.app`).

You can immediately test it via cURL:
```bash
curl -X POST https://opto-proxy-abc123.a.run.app/v1/chat/completions \
  -H "Authorization: Bearer opto_test_user_1" \
  -H "x-openai-key: YOUR_ACTUAL_OPENAI_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello world!"}]
  }'
```