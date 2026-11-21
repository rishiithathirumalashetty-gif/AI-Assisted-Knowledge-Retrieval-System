import { Injectable } from '@angular/core';

import { HttpClient } from '@angular/common/http';

@Injectable({
  providedIn: 'root'
})

export class ApiService {

  constructor(private http: HttpClient) { }

  uploadFile(data: FormData){

    return this.http.post(

      'http://localhost:3000/upload',

      data

    );

  }

  explainFile(fileName: string){

    return this.http.post(

      'http://localhost:3000/chat',

      {
        question: 'Explain this code line by line',
        fileName: fileName
      }

    );

  }

}