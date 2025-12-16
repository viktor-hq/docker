# Use a base Alpine image, lightweight and minimal
FROM alpine:latest

# Install necessary dependencies for the shell script
# curl: for the API call
# jq: for JSON parsing (extraction of message, tokens)
# bc: for calculating time in milliseconds
RUN apk update && \
    apk add --no-cache curl jq bc && \
    rm -rf /var/cache/apk/*

# Copy the entry script into the image
COPY entrypoint.sh /usr/local/bin/viktor

# Make the script executable
RUN chmod +x /usr/local/bin/viktor

# Define the default entrypoint.
# When the user runs the container, this script will be executed.
ENTRYPOINT ["/usr/local/bin/viktor"]