# Repository Guidelines

## Project Structure & Module Organization

This is a single-module Java 21 Spring Boot application built with Gradle. Web MVC and WebSocket dependencies are configured; it serves a group-call frontend, `/ws/rooms` signaling, `/api/call-config`, and the original `GET /greeting` endpoint.

- `src/main/java/com/saldev/webrtc/`: application entry point and Java sources. Keep HTTP handlers in `controller`, business logic in `service`, and response objects in `model/response`.
- `src/main/resources/application.properties`: application configuration. The plain HTML/CSS/JavaScript frontend lives in `src/main/resources/static/`; no frontend build step is required.
- `src/test/java/com/saldev/webrtc/`: tests, mirroring the production package structure.
- `build.gradle`, `settings.gradle`, and `gradle/wrapper/`: build configuration and pinned Gradle wrapper.
- `build/`: generated classes, artifacts, and reports; do not edit or commit generated output.

## Build, Test, and Development Commands

Use the checked-in wrapper from the repository root with JDK 21 available. On Windows, substitute `gradlew.bat` for `./gradlew`.

- `./gradlew bootRun`: start the application locally.
- `./gradlew test`: run the test suite through JUnit Platform.
- `./gradlew build`: compile, test, and produce application artifacts in `build/libs/`.
- `./gradlew clean build`: rebuild from a clean output directory.
- `./gradlew test --tests com.saldev.webrtc.WebrtcApplicationTests`: run the existing context-load test class.

Use `./gradlew bootRun --args='--server.port=8081'` if port 8080 is occupied. See `README.md` for the optional Playwright browser test, local media testing, and deployment constraints.

## Coding Style & Naming Conventions

Use four-space indentation for new controller, service, and model code. Preserve existing tabs in generated bootstrap, test, and Gradle files when editing them. No formatter or lint plugin is configured.

Use lowercase package names, PascalCase classes, and camelCase methods and fields. Follow role-based names such as `GreetingController`, `GreetingService`, and `GreetingResponse`. Prefer constructor injection, keep controllers focused on HTTP handling, and follow existing Lombok usage for response objects.

## Testing Guidelines

Tests use JUnit Jupiter and Spring Boot test support. Name test classes `*Tests` and use descriptive test methods. Use focused unit tests for service behavior and Spring integration tests where application wiring matters. The existing `@SpringBootTest` verifies context startup; no coverage threshold is configured. Run `./gradlew test` before submitting changes.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so no established commit convention can be verified. Use concise, imperative subjects such as `Add greeting endpoint tests`. Keep commits focused.

Pull requests should explain the change, link relevant issues, and report validation commands and results. For API changes, include example requests and responses. Keep secrets out of committed configuration; supply sensitive values through environment variables or external configuration.
