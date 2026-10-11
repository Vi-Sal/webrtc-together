# Build the backend and bundled static frontend with the repository's Gradle wrapper.
FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /workspace
COPY gradlew build.gradle settings.gradle ./
COPY gradle ./gradle
COPY src ./src
RUN chmod +x gradlew && ./gradlew --no-daemon --max-workers=2 test bootJar

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
# Copy only the executable application artifact.
COPY --from=build /workspace/build/libs/app.jar ./app.jar
ENV PORT=10000
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=60.0 -XX:+ExitOnOutOfMemoryError"
USER 10001:10001
EXPOSE 10000
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
