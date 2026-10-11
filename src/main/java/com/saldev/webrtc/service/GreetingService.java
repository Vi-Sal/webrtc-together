package com.saldev.webrtc.service;

import com.saldev.webrtc.model.response.GreetingResponse;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;

@Service
public class GreetingService {
    public GreetingResponse greeting() {
        return GreetingResponse.builder()
                .message("Hello bro...")
                .date(LocalDateTime.now())
                .build();
    }
}
